import { exec } from "child_process";
import fs from "fs";
import path from "path";
import { createServiceClient } from "../lib/supabase";
import { SUPABASE_STORAGE_BUCKETS } from "./upload";
import { promisify } from "util";

const execAsync = promisify(exec);
const supabaseService = createServiceClient();

const TMP_DIR = "/tmp";

/**
 * Downloads a video from Supabase storage and returns it as a Blob
 */
export async function downloadVideoFromSupabase(videoId: string): Promise<Blob> {
  const videoStoragePath = `videos/${videoId}.mp4`;
  
  const { data: videoData, error: downloadError } = await supabaseService.storage
    .from(SUPABASE_STORAGE_BUCKETS.TMP_VIDEOS)
    .download(videoStoragePath);

  if (downloadError) {
    throw new Error(`Video not found in storage: ${downloadError.message}`);
  }

  if (!videoData) {
    throw new Error("Video data is null");
  }

  return videoData;
}

/**
 * Extracts audio from a video file using ffmpeg
 * Returns the path to the extracted audio file
 */
export async function extractAudioFromVideo(videoPath: string, videoId: string): Promise<string> {
  const audioPath = path.join(TMP_DIR, `${videoId}.mp3`);
  
  const cmd = `ffmpeg -y -i "${videoPath}" -vn -acodec libmp3lame -q:a 2 "${audioPath}"`;
  
  try {
    await execAsync(cmd);
    return audioPath;
  } catch (err: any) {
    throw new Error(`FFmpeg audio extraction error: ${err.message}`);
  }
}

/**
 * Extracts a thumbnail from a video file using ffmpeg
 * Returns the path to the extracted thumbnail file
 */
export async function extractThumbnailFromVideo(videoPath: string, videoId: string): Promise<string> {
  const thumbnailPath = path.join(TMP_DIR, `${videoId}.jpg`);
  
  // Extract thumbnail at 1 second into the video
  const cmd = `ffmpeg -y -i "${videoPath}" -ss 00:00:00 -vframes 1 -q:v 2 "${thumbnailPath}"`;
  
  try {
    await execAsync(cmd);
    return thumbnailPath;
  } catch (err: any) {
    throw new Error(`FFmpeg thumbnail extraction error: ${err.message}`);
  }
}

/**
 * Saves audio file to Supabase storage
 * Returns the storage path and public URL
 */
export async function saveAudioToSupabase(audioPath: string, videoId: string): Promise<{ path: string; url: string }> {
  const audioStoragePath = `audios/${videoId}.mp3`;
  const audioStream = fs.createReadStream(audioPath);
  
  const { error: uploadError } = await supabaseService.storage
    .from(SUPABASE_STORAGE_BUCKETS.TMP_VIDEOS)
    .upload(audioStoragePath, audioStream, {
      contentType: "audio/mpeg",
      upsert: true,
    });

  if (uploadError) {
    throw new Error(`Failed to upload audio: ${uploadError.message}`);
  }

  const audioUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/${SUPABASE_STORAGE_BUCKETS.TMP_VIDEOS}/${audioStoragePath}`;
  
  return {
    path: audioStoragePath,
    url: audioUrl,
  };
}

/**
 * Saves thumbnail file to Supabase storage
 * Returns the storage path and public URL
 */
export async function saveThumbnailToSupabase(thumbnailPath: string, videoId: string): Promise<{ path: string; url: string }> {
  const thumbnailStoragePath = `thumbnails/${videoId}.jpg`;
  const thumbnailStream = fs.createReadStream(thumbnailPath);
  
  const { error: uploadError } = await supabaseService.storage
    .from(SUPABASE_STORAGE_BUCKETS.TMP_VIDEOS)
    .upload(thumbnailStoragePath, thumbnailStream, {
      contentType: "image/jpeg",
      upsert: true,
    });

  if (uploadError) {
    throw new Error(`Failed to upload thumbnail: ${uploadError.message}`);
  }

  const { data: { publicUrl: thumbnailUrl } } = supabaseService.storage.from(SUPABASE_STORAGE_BUCKETS.TMP_VIDEOS).getPublicUrl(thumbnailStoragePath);
  
  return {
    path: thumbnailStoragePath,
    url: thumbnailUrl,
  };
}

/**
 * Helper function to write blob to temporary file
 */
export async function writeBlobToFile(blob: Blob, filePath: string): Promise<void> {
  const arrayBuffer = await blob.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  fs.writeFileSync(filePath, buffer);
}

/**
 * Helper function to cleanup temporary files
 */
export function cleanupFiles(...filePaths: string[]): void {
  filePaths.forEach((filePath) => {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  });
}
