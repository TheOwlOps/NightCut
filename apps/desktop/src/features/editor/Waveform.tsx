import { useEffect, useRef } from "react";

/** Decoded peak cache, keyed by media URL. Decoding happens once per
 * imported file, off the render path. */
const peakCache = new Map<string, Promise<number[]>>();

export function loadPeaks(url: string, buckets = 96): Promise<number[]> {
  const hit = peakCache.get(url);
  if (hit) return hit;
  const job = (async () => {
    const res = await fetch(url);
    const buf = await res.arrayBuffer();
    const ctx = new OfflineAudioContext(1, 1, 8000);
    const audio = await ctx.decodeAudioData(buf);
    const data = audio.getChannelData(0);
    const peaks: number[] = [];
    const per = Math.max(1, Math.floor(data.length / buckets));
    for (let b = 0; b < buckets; b++) {
      let max = 0;
      const start = b * per;
      for (let i = start; i < Math.min(data.length, start + per); i++) {
        max = Math.max(max, Math.abs(data[i]));
      }
      peaks.push(max);
    }
    return peaks;
  })().catch(() => [] as number[]);
  peakCache.set(url, job);
  return job;
}

/** Tiny waveform strip drawn under a timeline clip (CapCut shows audio
 * waveforms on clips). Silent no-op until peaks are decoded. */
export default function Waveform({ url, color }: { url: string; color: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    void loadPeaks(url).then((peaks) => {
      const canvas = ref.current;
      if (cancelled || !canvas || peaks.length === 0) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const { width, height } = canvas;
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = color;
      const barW = width / peaks.length;
      peaks.forEach((p, i) => {
        const h = Math.max(1, p * height);
        ctx.fillRect(i * barW, (height - h) / 2, Math.max(1, barW - 0.5), h);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [url, color]);
  return <canvas ref={ref} className="clip-wave" width={240} height={36} />;
}
