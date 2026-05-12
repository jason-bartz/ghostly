//! Watches for system audio device changes (device list and default input)
//! so the audio stream can be reopened on the correct hardware automatically.
//!
//! macOS-only: uses CoreAudio property listeners. On other platforms this is
//! a no-op stub.

#[cfg(target_os = "macos")]
mod imp {
    use log::{debug, warn};
    use std::ffi::c_void;
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, Instant};

    type AudioObjectID = u32;
    type AudioObjectPropertySelector = u32;
    type AudioObjectPropertyScope = u32;
    type AudioObjectPropertyElement = u32;
    type OSStatus = i32;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct AudioObjectPropertyAddress {
        selector: AudioObjectPropertySelector,
        scope: AudioObjectPropertyScope,
        element: AudioObjectPropertyElement,
    }

    type AudioObjectPropertyListenerProc = unsafe extern "C" fn(
        in_object_id: AudioObjectID,
        in_number_addresses: u32,
        in_addresses: *const AudioObjectPropertyAddress,
        in_client_data: *mut c_void,
    ) -> OSStatus;

    #[link(name = "CoreAudio", kind = "framework")]
    extern "C" {
        fn AudioObjectAddPropertyListener(
            in_object_id: AudioObjectID,
            in_address: *const AudioObjectPropertyAddress,
            in_listener: AudioObjectPropertyListenerProc,
            in_client_data: *mut c_void,
        ) -> OSStatus;

        fn AudioObjectRemovePropertyListener(
            in_object_id: AudioObjectID,
            in_address: *const AudioObjectPropertyAddress,
            in_listener: AudioObjectPropertyListenerProc,
            in_client_data: *mut c_void,
        ) -> OSStatus;
    }

    const K_AUDIO_OBJECT_SYSTEM_OBJECT: AudioObjectID = 1;

    const fn fourcc(s: &[u8; 4]) -> u32 {
        ((s[0] as u32) << 24) | ((s[1] as u32) << 16) | ((s[2] as u32) << 8) | (s[3] as u32)
    }
    const K_AUDIO_HARDWARE_PROPERTY_DEVICES: u32 = fourcc(b"dev#");
    const K_AUDIO_HARDWARE_PROPERTY_DEFAULT_INPUT_DEVICE: u32 = fourcc(b"dIn ");
    const K_AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL: u32 = fourcc(b"glob");
    const K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN: u32 = 0;

    fn watched_addresses() -> [AudioObjectPropertyAddress; 2] {
        [
            AudioObjectPropertyAddress {
                selector: K_AUDIO_HARDWARE_PROPERTY_DEVICES,
                scope: K_AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL,
                element: K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN,
            },
            AudioObjectPropertyAddress {
                selector: K_AUDIO_HARDWARE_PROPERTY_DEFAULT_INPUT_DEVICE,
                scope: K_AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL,
                element: K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN,
            },
        ]
    }

    unsafe extern "C" fn listener_trampoline(
        _in_object_id: AudioObjectID,
        _in_number_addresses: u32,
        _in_addresses: *const AudioObjectPropertyAddress,
        in_client_data: *mut c_void,
    ) -> OSStatus {
        if in_client_data.is_null() {
            return 0;
        }
        let sender = &*(in_client_data as *const mpsc::Sender<()>);
        let _ = sender.send(());
        0
    }

    /// Fires `callback` (debounced ~300ms) whenever the audio device list or
    /// default input device changes. Listener is removed on Drop; the boxed
    /// channel sender is intentionally leaked so that any in-flight CoreAudio
    /// callback that is still racing past `AudioObjectRemovePropertyListener`
    /// cannot read freed memory.
    pub struct DeviceWatcher {
        addresses: Vec<AudioObjectPropertyAddress>,
        client_data: *mut c_void,
        worker: Option<thread::JoinHandle<()>>,
    }

    // The raw pointer is only dereferenced inside the CoreAudio callback and
    // freed never (intentionally leaked on drop).
    unsafe impl Send for DeviceWatcher {}
    unsafe impl Sync for DeviceWatcher {}

    impl DeviceWatcher {
        pub fn new<F>(callback: F) -> Result<Self, String>
        where
            F: Fn() + Send + 'static,
        {
            let (event_tx, event_rx) = mpsc::channel::<()>();
            let client_data = Box::into_raw(Box::new(event_tx)) as *mut c_void;
            let addresses = watched_addresses().to_vec();

            for addr in &addresses {
                let status = unsafe {
                    AudioObjectAddPropertyListener(
                        K_AUDIO_OBJECT_SYSTEM_OBJECT,
                        addr as *const _,
                        listener_trampoline,
                        client_data,
                    )
                };
                if status != 0 {
                    return Err(format!(
                        "AudioObjectAddPropertyListener failed for selector 0x{:08x}: {}",
                        addr.selector, status
                    ));
                }
            }

            let worker = thread::Builder::new()
                .name("ghostly-audio-device-watcher".into())
                .spawn(move || {
                    const DEBOUNCE: Duration = Duration::from_millis(300);
                    while event_rx.recv().is_ok() {
                        let deadline = Instant::now() + DEBOUNCE;
                        loop {
                            let remaining = deadline.saturating_duration_since(Instant::now());
                            if remaining.is_zero() {
                                break;
                            }
                            match event_rx.recv_timeout(remaining) {
                                Ok(()) => continue,
                                Err(mpsc::RecvTimeoutError::Timeout) => break,
                                Err(mpsc::RecvTimeoutError::Disconnected) => return,
                            }
                        }
                        debug!("Audio device change detected");
                        callback();
                    }
                })
                .map_err(|e| format!("Failed to spawn watcher thread: {e}"))?;

            Ok(Self {
                addresses,
                client_data,
                worker: Some(worker),
            })
        }
    }

    impl Drop for DeviceWatcher {
        fn drop(&mut self) {
            for addr in &self.addresses {
                let status = unsafe {
                    AudioObjectRemovePropertyListener(
                        K_AUDIO_OBJECT_SYSTEM_OBJECT,
                        addr as *const _,
                        listener_trampoline,
                        self.client_data,
                    )
                };
                if status != 0 {
                    warn!(
                        "AudioObjectRemovePropertyListener failed for selector 0x{:08x}: {}",
                        addr.selector, status
                    );
                }
            }
            // The worker's only Sender is the one held by client_data. We
            // intentionally leak it (see struct doc): once leaked, the Sender
            // is never dropped, so event_rx.recv() blocks forever and the
            // worker thread parks for the rest of the process lifetime. This
            // matches the typical lifetime of DeviceWatcher (one per app).
            let _ = self.worker.take();
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    pub struct DeviceWatcher;

    impl DeviceWatcher {
        pub fn new<F>(_callback: F) -> Result<Self, String>
        where
            F: Fn() + Send + 'static,
        {
            Ok(Self)
        }
    }
}

pub use imp::DeviceWatcher;
