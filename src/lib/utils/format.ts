export const formatModelSize = (sizeMb: number | null | undefined): string => {
  if (!sizeMb || !Number.isFinite(sizeMb) || sizeMb <= 0) {
    return "Unknown size";
  }

  if (sizeMb >= 1024) {
    const sizeGb = sizeMb / 1024;
    const formatter = new Intl.NumberFormat(undefined, {
      minimumFractionDigits: sizeGb >= 10 ? 0 : 1,
      maximumFractionDigits: sizeGb >= 10 ? 0 : 1,
    });
    return `${formatter.format(sizeGb)} GB`;
  }

  const formatter = new Intl.NumberFormat(undefined, {
    minimumFractionDigits: sizeMb >= 100 ? 0 : 1,
    maximumFractionDigits: sizeMb >= 100 ? 0 : 1,
  });

  return `${formatter.format(sizeMb)} MB`;
};

export const formatBytes = (bytes: number | null | undefined): string => {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
    return "—";
  }
  const mb = bytes / (1024 * 1024);
  return formatModelSize(mb);
};

export const formatEta = (seconds: number | null | undefined): string => {
  if (
    seconds === null ||
    seconds === undefined ||
    !Number.isFinite(seconds) ||
    seconds < 0
  ) {
    return "—";
  }
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return rem ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mRem = m % 60;
  return mRem ? `${h}h ${mRem}m` : `${h}h`;
};
