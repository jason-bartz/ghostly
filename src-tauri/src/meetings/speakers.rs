//! Speaker identity for a meeting.
//!
//! Three layers, in increasing cost and decreasing certainty:
//!
//! 1. **Lane attribution** — the microphone is the user, the system tap is
//!    everyone else. Free, exact, and always applied.
//! 2. **Clustering** — groups the far-side lane into distinct voices by
//!    embedding similarity. Provisional; refined at the end of the meeting.
//! 3. **Naming** — the user, a calendar roster, or a stored voiceprint turns
//!    "Speaker 2" into "Sarah". Authoritative and never overwritten.
//!
//! Layer 2 needs a speaker-embedding model. The clustering itself lives here
//! and is exercised by tests; [`EmbeddingProvider`] is the seam a bundled ONNX
//! model plugs into. Until one is present, [`SpeakerRegistry`] runs on layers 1
//! and 3, which is a complete and useful product on its own.

use anyhow::Result;

use super::store::MeetingStore;
use super::types::{Lane, MeetingSpeaker, SpeakerKind};

/// Produces a fixed-dimension embedding for a speech segment.
///
/// Implementations must return vectors comparable under cosine distance. A
/// segment shorter than roughly one second does not carry enough signal, and
/// implementations should return `None` rather than a low-confidence vector.
pub trait EmbeddingProvider: Send + Sync {
    fn embed(&self, samples: &[f32], sample_rate: u32) -> Option<Vec<f32>>;
}

/// Resolves which speaker a segment belongs to, creating rows on demand.
pub struct SpeakerRegistry<'a> {
    store: &'a MeetingStore,
    meeting_id: String,
    me: Option<MeetingSpeaker>,
    others: Option<MeetingSpeaker>,
}

impl<'a> SpeakerRegistry<'a> {
    pub fn new(store: &'a MeetingStore, meeting_id: &str) -> Self {
        Self {
            store,
            meeting_id: meeting_id.to_string(),
            me: None,
            others: None,
        }
    }

    /// The speaker a lane's audio is attributed to before clustering runs.
    pub fn speaker_for(&mut self, lane: Lane) -> Result<MeetingSpeaker> {
        match lane {
            Lane::Mic => {
                if let Some(existing) = &self.me {
                    return Ok(existing.clone());
                }
                let speaker = self.create(Lane::Mic, SpeakerKind::Me, Some("You"), 0)?;
                self.me = Some(speaker.clone());
                Ok(speaker)
            }
            Lane::System => {
                if let Some(existing) = &self.others {
                    return Ok(existing.clone());
                }
                // Unnamed rather than "Others": clustering may later split this
                // into real people, and a placeholder that reads like a name
                // would be misleading in the meantime.
                let speaker = self.create(Lane::System, SpeakerKind::Unknown, None, 1)?;
                self.others = Some(speaker.clone());
                Ok(speaker)
            }
        }
    }

    fn create(
        &self,
        lane: Lane,
        kind: SpeakerKind,
        display_name: Option<&str>,
        color_index: i64,
    ) -> Result<MeetingSpeaker> {
        let speaker = MeetingSpeaker {
            id: format!("spk_{}_{}", self.meeting_id, lane.as_str()),
            meeting_id: self.meeting_id.clone(),
            display_name: display_name.map(str::to_string),
            kind,
            lane,
            cluster_index: None,
            voiceprint_id: None,
            pinned: false,
            color_index,
        };
        self.store.upsert_speaker(&speaker)?;
        Ok(speaker)
    }
}

/// Cosine distance in `[0, 2]`. Zero means identical direction.
pub fn cosine_distance(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return f32::MAX;
    }
    let mut dot = 0.0f32;
    let mut norm_a = 0.0f32;
    let mut norm_b = 0.0f32;
    for (x, y) in a.iter().zip(b.iter()) {
        dot += x * y;
        norm_a += x * x;
        norm_b += y * y;
    }
    if norm_a == 0.0 || norm_b == 0.0 {
        return f32::MAX;
    }
    1.0 - (dot / (norm_a.sqrt() * norm_b.sqrt()))
}

/// A group of segments believed to be one voice.
#[derive(Debug, Clone)]
pub struct Cluster {
    pub centroid: Vec<f32>,
    pub members: Vec<i64>,
}

impl Cluster {
    fn absorb(&mut self, embedding: &[f32], segment_id: i64) {
        // Running mean, so a long-talking speaker's centroid stays
        // representative rather than being dominated by their first utterance.
        let count = self.members.len() as f32;
        for (index, value) in self.centroid.iter_mut().enumerate() {
            *value = (*value * count + embedding[index]) / (count + 1.0);
        }
        self.members.push(segment_id);
    }
}

/// Threshold-based agglomerative clustering.
///
/// Threshold-based rather than k-means because the number of participants is
/// unknown — k-means would need a fixed k and force every voice into it.
pub struct SpeakerClusterer {
    clusters: Vec<Cluster>,
    threshold: f32,
}

impl SpeakerClusterer {
    /// `threshold` is the maximum cosine distance at which a segment joins an
    /// existing cluster. Around 0.6–0.75 suits most speaker-embedding models;
    /// lower splits one person in two, higher merges different people.
    pub fn new(threshold: f32) -> Self {
        Self {
            clusters: Vec::new(),
            threshold,
        }
    }

    /// Assigns a segment, creating a cluster when nothing is close enough.
    /// Returns the cluster index.
    pub fn assign(&mut self, segment_id: i64, embedding: &[f32]) -> usize {
        let mut best: Option<(usize, f32)> = None;
        for (index, cluster) in self.clusters.iter().enumerate() {
            let distance = cosine_distance(embedding, &cluster.centroid);
            if best.map_or(true, |(_, d)| distance < d) {
                best = Some((index, distance));
            }
        }

        match best {
            Some((index, distance)) if distance <= self.threshold => {
                self.clusters[index].absorb(embedding, segment_id);
                index
            }
            _ => {
                self.clusters.push(Cluster {
                    centroid: embedding.to_vec(),
                    members: vec![segment_id],
                });
                self.clusters.len() - 1
            }
        }
    }

    pub fn clusters(&self) -> &[Cluster] {
        &self.clusters
    }

    /// Discards clusters with too few members, folding them into their nearest
    /// surviving neighbour.
    ///
    /// Online clustering spawns spurious singletons from crosstalk and noise;
    /// without this the end-of-meeting speaker list is cluttered with voices
    /// that said one word.
    pub fn prune(&mut self, min_members: usize) {
        if self.clusters.len() <= 1 {
            return;
        }
        let (keep, drop): (Vec<Cluster>, Vec<Cluster>) = self
            .clusters
            .drain(..)
            .partition(|c| c.members.len() >= min_members);

        // Everything was small — keep the largest so the meeting still has a
        // speaker rather than none.
        if keep.is_empty() {
            let mut drop = drop;
            drop.sort_by_key(|c| std::cmp::Reverse(c.members.len()));
            self.clusters = drop.into_iter().take(1).collect();
            return;
        }

        self.clusters = keep;
        for orphan in drop {
            let mut best_index = 0;
            let mut best_distance = f32::MAX;
            for (index, cluster) in self.clusters.iter().enumerate() {
                let distance = cosine_distance(&orphan.centroid, &cluster.centroid);
                if distance < best_distance {
                    best_distance = distance;
                    best_index = index;
                }
            }
            self.clusters[best_index].members.extend(orphan.members);
        }
    }
}

/// Re-clusters a finished meeting and rewrites provisional speaker labels.
///
/// Offline clustering sees every embedding at once and is materially more
/// accurate than the online pass. Segments the user labelled by hand are
/// excluded by the query, so manual work is never undone.
pub fn recluster_meeting(store: &MeetingStore, meeting_id: &str, threshold: f32) -> Result<usize> {
    let rows = store.segments_with_embeddings(meeting_id)?;
    // Only the far side needs clustering — the microphone lane is the user.
    let system_rows: Vec<_> = rows
        .into_iter()
        .filter(|(_, lane, _)| *lane == Lane::System)
        .collect();
    if system_rows.len() < 2 {
        return Ok(0);
    }

    let mut clusterer = SpeakerClusterer::new(threshold);
    for (segment_id, _, embedding) in &system_rows {
        clusterer.assign(*segment_id, embedding);
    }
    clusterer.prune(2);

    let existing = store.list_speakers(meeting_id)?;
    let mut next_color = existing.iter().map(|s| s.color_index).max().unwrap_or(0) + 1;

    let mut relabelled = 0usize;
    for (index, cluster) in clusterer.clusters().iter().enumerate() {
        let speaker = MeetingSpeaker {
            id: format!("spk_{meeting_id}_cluster{index}"),
            meeting_id: meeting_id.to_string(),
            display_name: None,
            kind: SpeakerKind::Unknown,
            lane: Lane::System,
            cluster_index: Some(index as i64),
            voiceprint_id: None,
            pinned: false,
            color_index: next_color,
        };
        next_color += 1;
        store.upsert_speaker(&speaker)?;

        for segment_id in &cluster.members {
            store.set_segment_speaker_clustered(*segment_id, &speaker.id)?;
            relabelled += 1;
        }
    }
    Ok(relabelled)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit(values: &[f32]) -> Vec<f32> {
        values.to_vec()
    }

    #[test]
    fn cosine_distance_of_identical_vectors_is_zero() {
        let a = unit(&[1.0, 2.0, 3.0]);
        assert!(cosine_distance(&a, &a).abs() < 1e-6);
    }

    #[test]
    fn cosine_distance_of_orthogonal_vectors_is_one() {
        let a = unit(&[1.0, 0.0]);
        let b = unit(&[0.0, 1.0]);
        assert!((cosine_distance(&a, &b) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn mismatched_or_empty_vectors_are_maximally_distant() {
        assert_eq!(cosine_distance(&[1.0, 2.0], &[1.0]), f32::MAX);
        assert_eq!(cosine_distance(&[], &[]), f32::MAX);
        // A zero vector has no direction, so distance is undefined.
        assert_eq!(cosine_distance(&[0.0, 0.0], &[1.0, 1.0]), f32::MAX);
    }

    #[test]
    fn groups_similar_embeddings_and_separates_dissimilar_ones() {
        let mut clusterer = SpeakerClusterer::new(0.3);
        // Two tight groups pointing in clearly different directions.
        let a1 = clusterer.assign(1, &[1.0, 0.0, 0.0]);
        let a2 = clusterer.assign(2, &[0.98, 0.05, 0.0]);
        let b1 = clusterer.assign(3, &[0.0, 1.0, 0.0]);
        let b2 = clusterer.assign(4, &[0.02, 0.99, 0.0]);

        assert_eq!(a1, a2, "similar embeddings belong to one cluster");
        assert_eq!(b1, b2, "similar embeddings belong to one cluster");
        assert_ne!(a1, b1, "dissimilar embeddings must not merge");
        assert_eq!(clusterer.clusters().len(), 2);
    }

    #[test]
    fn centroid_tracks_the_running_mean() {
        let mut clusterer = SpeakerClusterer::new(1.5);
        clusterer.assign(1, &[2.0, 0.0]);
        clusterer.assign(2, &[0.0, 2.0]);
        let centroid = &clusterer.clusters()[0].centroid;
        assert!((centroid[0] - 1.0).abs() < 1e-6);
        assert!((centroid[1] - 1.0).abs() < 1e-6);
    }

    #[test]
    fn prune_folds_singletons_into_their_nearest_neighbour() {
        let mut clusterer = SpeakerClusterer::new(0.05);
        clusterer.assign(1, &[1.0, 0.0, 0.0]);
        clusterer.assign(2, &[1.0, 0.0, 0.0]);
        clusterer.assign(3, &[0.0, 1.0, 0.0]);
        assert_eq!(clusterer.clusters().len(), 2);

        clusterer.prune(2);
        assert_eq!(clusterer.clusters().len(), 1, "the singleton is folded in");
        assert_eq!(clusterer.clusters()[0].members.len(), 3);
    }

    #[test]
    fn prune_keeps_the_largest_when_every_cluster_is_small() {
        let mut clusterer = SpeakerClusterer::new(0.05);
        clusterer.assign(1, &[1.0, 0.0]);
        clusterer.assign(2, &[0.0, 1.0]);
        clusterer.prune(5);
        assert_eq!(
            clusterer.clusters().len(),
            1,
            "a meeting must never end with zero speakers"
        );
    }
}
