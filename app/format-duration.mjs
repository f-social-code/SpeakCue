/** Format nonnegative seconds for display without changing the measured value. */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "Unavailable";
  const totalSeconds = Math.round(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  if (minutes === 0) return `${remainingSeconds} sec`;
  if (remainingSeconds === 0) return `${minutes} min`;
  return `${minutes} min ${remainingSeconds} sec`;
}
