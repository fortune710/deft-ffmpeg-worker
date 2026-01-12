import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient, createServiceClient } from './lib/supabase';
import { exec } from "child_process";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import { generateAudioPath, generateVideoPath, SUPABASE_STORAGE_BUCKETS } from './utils/upload';

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

  const videoStoragePath = `videos/${videoId}.mp4`;
  const videoPath = path.join(TMP_DIR, `${videoId}.mp4`);
  const audioPath = path.join(TMP_DIR, `${videoId}.mp3`);
  const audioStoragePath = `audios/${videoId}.mp3`;

  try {
    // 1️⃣ Download the video from Supabase storage to TMP_DIR
    const { data: videoData, error: downloadError } = await supabaseService.storage
      .from(SUPABASE_STORAGE_BUCKETS.TMP_VIDEOS)
      .download(videoStoragePath);

    if (downloadError) {
      return res.status(404).json({ 
        error: "Video not found in storage", 
        details: downloadError.message,
        data: null, 
        success: false 
      });
    }

    // Convert blob to buffer and write to file
    const arrayBuffer = await videoData.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    fs.writeFileSync(videoPath, buffer);

    // 2️⃣ Extract audio using ffmpeg
    await new Promise((resolve, reject) => {
      const cmd = `ffmpeg -y -i "${videoPath}" -vn -acodec libmp3lame -q:a 2 "${audioPath}"`;
      exec(cmd, (err, stdout, stderr) => {
        if (err) {
          // Cleanup video file on error
          if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
          return reject(new Error(`FFmpeg error: ${err.message}`));
        }
        resolve(undefined);
      });
    });

    // 3️⃣ Upload audio to Supabase storage
    const audioStream = fs.createReadStream(audioPath);
    const { error: uploadError } = await supabaseService.storage
      .from(SUPABASE_STORAGE_BUCKETS.TMP_VIDEOS)
      .upload(audioStoragePath, audioStream, {
        contentType: "audio/mpeg",
        upsert: true,
      });

    // Cleanup temporary files
    if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
    if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);

    if (uploadError) {
      return res.status(500).json({ 
        error: uploadError.message, 
        data: null, 
        success: false 
      });
    }

    const audioUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/${SUPABASE_STORAGE_BUCKETS.TMP_VIDEOS}/${audioStoragePath}`;

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
    if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
    if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
    
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
