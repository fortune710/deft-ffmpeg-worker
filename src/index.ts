import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient, createServiceClient } from './lib/supabase';
import { exec } from "child_process";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import { generateAudioPath, generateVideoPath, SUPABASE_STORAGE_BUCKETS } from './utils/upload';
import {
  downloadVideoFromSupabase,
  extractAudioFromVideo,
  extractThumbnailFromVideo,
  saveAudioToSupabase,
  saveThumbnailToSupabase,
  writeBlobToFile,
  cleanupFiles,
} from './utils/videoProcessing';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize Supabase clients
const supabase = createClient();
const supabaseService = createServiceClient();

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', message: 'Server is running' });
});

// Example endpoint using Supabase
app.get('/api/test', async (req: Request, res: Response) => {
  try {
    // Example: Test Supabase connection
    // Replace 'your_table_name' with an actual table from your Supabase database
    const { data, error } = await supabase
      .from('your_table_name')
      .select('*')
      .limit(1);
    
    if (error) {
      console.error('Supabase error:', error);
      return res.status(500).json({ 
        error: 'Database connection error', 
        details: error.message,
        note: 'Make sure you have created a table in your Supabase database'
      });
    }
    
    res.json({ 
      message: 'Supabase connection successful',
      data 
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post("/download", async (req, res) => {
  const { video_url: videoUrl, video_id: videoId } = req.body;

  if (!videoUrl || !videoId) {
    return res.status(400).json({ error: "Missing videoUrl or videoId", data: null, success: false });
  }

  const outputFile = path.join(TMP_DIR, generateVideoPath(videoUrl));

  const cmd = `
    yt-dlp -f "bestvideo+bestaudio/best" --merge-output-format mp4 -o "${outputFile}" "${videoUrl}"
  `;

  exec(cmd, async (error) => {
    if (error) {
      return res.status(500).json({ error: error.message, data: null, success: false });
    }

    const stream = fs.createReadStream(outputFile);
    const videoPath = `videos/${videoId}.mp4`;

    const { error: uploadError } = await supabaseService.storage
      .from(SUPABASE_STORAGE_BUCKETS.TMP_VIDEOS)
      .upload(videoPath, stream, {
        contentType: "video/mp4",
        upsert: true,
      });

    fs.unlinkSync(outputFile);

    if (uploadError) {
      return res.status(500).json({ error: uploadError.message, data: null, success: false });
    }

    return res.json({ success: true, data: { video_path: videoPath }, message: "Video downloaded and uploaded successfully" });
  });
});

const TMP_DIR = "/tmp";
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);

/**
 * POST /extract-audio
 * {
 *   "video_id": "video123"
 * }
 */
app.post("/extract-audio", async (req, res) => {
  const { video_id: videoId } = req.body;
  if (!videoId) return res.status(400).json({ error: "Missing video_id", data: null, success: false });

  const videoPath = path.join(TMP_DIR, `${videoId}.mp4`);
  let audioPath: string | null = null;

  try {
    // 1️⃣ Download the video from Supabase storage
    const videoBlob = await downloadVideoFromSupabase(videoId);
    await writeBlobToFile(videoBlob, videoPath);

    // 2️⃣ Extract audio using ffmpeg
    audioPath = await extractAudioFromVideo(videoPath, videoId);

    // 3️⃣ Upload audio to Supabase storage
    const { path: audioStoragePath, url: audioUrl } = await saveAudioToSupabase(audioPath, videoId);

    // Cleanup temporary files
    cleanupFiles(videoPath, audioPath);

    return res.json({
      data: { 
        audio_path: audioStoragePath, 
        audio_url: audioUrl,
        video_id: videoId
      },
      success: true,
      message: "Audio extracted and uploaded successfully",
    });
  } catch (err: any) {
    // Cleanup on error
    cleanupFiles(videoPath, audioPath || "");
    
    console.error(err);
    return res.status(500).json({ 
      error: err.message || "Internal server error",
      data: null,
      success: false
    });
  }
});

/**
 * POST /extract?audio=true&thumbnail=true
 * Body: { "video_id": "video123" }
 * Query params:
 *   - audio: boolean (default: false) - extract audio
 *   - thumbnail: boolean (default: false) - extract thumbnail
 */
app.post("/extract", async (req, res) => {
  const { video_id: videoId } = req.body;
  if (!videoId) {
    return res.status(400).json({ 
      error: "Missing video_id", 
      data: null, 
      success: false 
    });
  }

  // Parse query params as booleans
  const audioParam = Array.isArray(req.query.audio) ? req.query.audio[0] : req.query.audio;
  const thumbnailParam = Array.isArray(req.query.thumbnail) ? req.query.thumbnail[0] : req.query.thumbnail;
  const extractAudio = typeof audioParam === 'string' && audioParam === 'true';
  const extractThumbnail = typeof thumbnailParam === 'string' && thumbnailParam === 'true';

  if (!extractAudio && !extractThumbnail) {
    return res.status(400).json({ 
      error: "At least one of 'audio' or 'thumbnail' query params must be true", 
      data: null, 
      success: false 
    });
  }

  const videoPath = path.join(TMP_DIR, `${videoId}.mp4`);
  let audioPath: string | null = null;
  let thumbnailPath: string | null = null;

  try {
    // 1️⃣ Download the video from Supabase storage
    const videoBlob = await downloadVideoFromSupabase(videoId);
    await writeBlobToFile(videoBlob, videoPath);

    const results: any = {
      video_id: videoId,
    };

    // 2️⃣ Extract audio if requested
    if (extractAudio) {
      audioPath = await extractAudioFromVideo(videoPath, videoId);
      const { path: audioStoragePath, url: audioUrl } = await saveAudioToSupabase(audioPath, videoId);
      results.audio_path = audioStoragePath;
      results.audio_url = audioUrl;
    }

    // 3️⃣ Extract thumbnail if requested
    if (extractThumbnail) {
      thumbnailPath = await extractThumbnailFromVideo(videoPath, videoId);
      const { path: thumbnailStoragePath, url: thumbnailUrl } = await saveThumbnailToSupabase(thumbnailPath, videoId);
      results.thumbnail_path = thumbnailStoragePath;
      results.thumbnail_url = thumbnailUrl;
    }

    // Cleanup temporary files
    cleanupFiles(videoPath, audioPath || "", thumbnailPath || "");

    return res.json({
      data: results,
      success: true,
      message: "Extraction completed successfully",
    });
  } catch (err: any) {
    // Cleanup on error
    cleanupFiles(videoPath, audioPath || "", thumbnailPath || "");
    
    console.error(err);
    return res.status(500).json({ 
      error: err.message || "Internal server error",
      data: null,
      success: false
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
