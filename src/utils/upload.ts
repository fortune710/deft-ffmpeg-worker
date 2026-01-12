import crypto from "crypto";

export const SUPABASE_STORAGE_BUCKETS = {
    TMP_VIDEOS: "tmp_videos",
} as const;

export function generateMediaHash(mediaUrl: string) {
  return crypto.createHash("sha256").update(mediaUrl).digest("hex");
}

export function generateVideoPath(mediaUrl: string) {
  return `videos/${generateMediaHash(mediaUrl)}.mp4`;
}

export function generateAudioPath(audioUrl: string) {
  return `audios/${generateMediaHash(audioUrl)}.mp3`;
}