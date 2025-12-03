/* tslint:disable */
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {GoogleGenAI} from '@google/genai';

// Define the aistudio property on the window object for TypeScript
declare global {
  interface AIStudio {
    openSelectKey: () => Promise<void>;
  }
  interface Window {
    aistudio?: AIStudio;
    JSZip: any; // Add JSZip type definition
  }
}

// --- Type Definitions ---
type ImageSize = '1K' | '2K' | '4K';
type VideoResolution = '720p' | '1080p';
type HistoryItem = { prompt: string; imageUrl: string };
type GenMode = 'standard' | 'clothing' | 'product' | 'nail' | 'video-standard' | 'video-shop' | 'bulk';
type MediaType = 'image' | 'video';

// --- Constants ---
const HISTORY_KEY = 'image-generation-history';
const MAX_HISTORY_ITEMS = 5;

// Safety settings to reduce false positives (blocking) on benign tasks like virtual try-on
// Using BLOCK_NONE is critical for tasks involving human figures and clothing modifications.
const permissiveSafetySettings = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' },
];

async function openApiKeyDialog() {
  if (window.aistudio?.openSelectKey) {
    await window.aistudio.openSelectKey();
  } else {
    alert('API key selection is not available. Please configure the API_KEY environment variable.');
  }
}

const statusEl = document.querySelector('#status') as HTMLDivElement;

function showStatusError(message: string) {
    if (statusEl) {
        statusEl.innerText = message;
        statusEl.className = 'text-center text-xs text-red-500 mt-3 font-medium min-h-[1.5em] px-4';
    }
}

function showStatusMessage(message: string) {
    if (statusEl) {
        statusEl.innerText = message;
        statusEl.className = 'text-center text-xs text-gray-400 mt-3 font-medium min-h-[1.5em]';
    }
}

// --- Image Processing Helpers ---

/**
 * Compresses a base64 image string by resizing and changing quality.
 * This is crucial to prevent localStorage QuotaExceededError and API Payload limits.
 */
function compressImage(base64Str: string, maxWidth: number = 800, quality: number = 0.7): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.src = base64Str;
    img.onload = () => {
      const canvas = document.createElement('canvas');
      let width = img.width;
      let height = img.height;

      if (width > maxWidth) {
        height = Math.round((height * maxWidth) / width);
        width = maxWidth;
      }

      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Could not get canvas context'));
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);
      // Convert to JPEG for better compression
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = (e) => reject(e);
  });
}

function handleGenerationError(candidate: any) {
    if (candidate.finishReason && candidate.finishReason !== 'STOP') {
        let msg = `Generation stopped: ${candidate.finishReason}`;
        // Provide clearer feedback for common opaque errors
        if (candidate.finishReason === 'IMAGE_OTHER') {
            msg = "The model blocked the generation (IMAGE_OTHER). This usually happens with complex image combinations or 'Virtual Try-On' prompts. Try a simpler prompt or use a different photo.";
        } else if (candidate.finishReason === 'SAFETY') {
            msg = "Generation blocked due to safety settings. Try modifying the prompt to be less specific about real people.";
        }
        throw new Error(msg);
    }
}

async function generateImage(
  prompt: string,
  apiKey: string,
  imageSize: ImageSize,
  aspectRatio: string,
): Promise<string> {
  const ai = new GoogleGenAI({apiKey});

  // Updated to use Gemini 3 Pro Image Preview
  const response = await ai.models.generateContent({
    model: 'gemini-3-pro-image-preview',
    contents: {
      parts: [
        {
          text: prompt,
        },
      ],
    },
    config: {
      safetySettings: permissiveSafetySettings,
      imageConfig: {
        imageSize: imageSize,
        aspectRatio: aspectRatio as any,
      },
    },
  });

  const candidate = response.candidates?.[0];
  if (candidate) {
      if (candidate.content?.parts) {
          for (const part of candidate.content.parts) {
              if (part.inlineData && part.inlineData.data) {
                  const mime = part.inlineData.mimeType || 'image/png';
                  return `data:${mime};base64,${part.inlineData.data}`;
              }
          }
          // If no image found, check for text refusal/explanation
          const textPart = candidate.content.parts.find(p => p.text);
          if (textPart?.text) {
               throw new Error(textPart.text);
          }
      }
      handleGenerationError(candidate);
  }

  throw new Error('The model failed to generate an image.');
}

// Optimized to handle multiple images (Person + Garment, or Product + Scene)
async function generateMultimodalImage(
  prompt: string,
  imageParts: {data: string, mimeType: string}[],
  apiKey: string,
  aspectRatio: string
): Promise<string> {
  const ai = new GoogleGenAI({apiKey});

  const parts: any[] = [];
  
  // Add all image parts
  imageParts.forEach(img => {
      parts.push({
          inlineData: {
              data: img.data,
              mimeType: img.mimeType
          }
      });
  });

  // Add text prompt
  parts.push({ text: prompt });

  // Uses Gemini 2.5 Flash Image ("Nano Banana") for multimodal tasks
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash-image',
    contents: {
      parts: parts,
    },
    config: {
        safetySettings: permissiveSafetySettings,
        imageConfig: {
            aspectRatio: aspectRatio as any,
        }
    }
  });

  const candidate = response.candidates?.[0];
  if (candidate) {
      if (candidate.content?.parts) {
          for (const part of candidate.content.parts) {
              if (part.inlineData && part.inlineData.data) {
                  const mime = part.inlineData.mimeType || 'image/png';
                  return `data:${mime};base64,${part.inlineData.data}`;
              }
          }
          // If no image found, check for text refusal/explanation
          const textPart = candidate.content.parts.find(p => p.text);
          if (textPart?.text) {
               throw new Error(textPart.text);
          }
      }
      handleGenerationError(candidate);
  }
  throw new Error('The model did not return an image.');
}

async function enhancePrompt(
  currentPrompt: string,
  apiKey: string,
): Promise<string> {
  const ai = new GoogleGenAI({apiKey});
  // Updated to use Gemini 3 Pro Preview for text
  const response = await ai.models.generateContent({
    model: 'gemini-3-pro-preview',
    contents: currentPrompt,
    config: {
      safetySettings: permissiveSafetySettings,
      systemInstruction: `You are a creative assistant that helps users write better prompts for an AI image generator.
Take the user's input and rewrite it into a more descriptive and detailed prompt.
Focus on adding details about the style, composition, lighting, and overall mood.
Return only the rewritten prompt, without any introduction or explanation.`,
    },
  });
  return response.text.trim();
}

async function generateRemixPrompt(
  originalPrompt: string,
  apiKey: string
): Promise<string> {
  const ai = new GoogleGenAI({apiKey});
  const response = await ai.models.generateContent({
    model: 'gemini-3-pro-preview',
    contents: `You are an AI art director.
    Task: Create a "Remix" of the following image prompt.
    Instructions:
    1. Keep the main subject and composition roughly the same.
    2. Change the artistic style, lighting, mood, or time of day.
    3. Make it a distinct variation.
    4. Output ONLY the new prompt text, do not add prefixes like "Remix:" or "Prompt:".

    Original Prompt: ${originalPrompt}`,
    config: {
        safetySettings: permissiveSafetySettings,
    }
  });
  return response.text.trim();
}

async function editImage(
  base64Image: string,
  prompt: string,
  apiKey: string,
): Promise<string> {
  const ai = new GoogleGenAI({apiKey});

  // Basic cleanup of base64 string to separate mime and data
  const match = base64Image.match(/^data:(image\/[a-z]+);base64,(.+)$/);
  if (!match) {
    throw new Error('Invalid image data found in source.');
  }
  const mimeType = match[1];
  const base64Data = match[2];

  // Uses Gemini 2.5 Flash Image ("Nano Banana")
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash-image',
    contents: {
      parts: [
        {
          inlineData: {
            data: base64Data,
            mimeType: mimeType,
          },
        },
        {
          text: prompt,
        },
      ],
    },
    config: {
        safetySettings: permissiveSafetySettings,
    }
  });

  const candidate = response.candidates?.[0];
  if (candidate) {
      if (candidate.content?.parts) {
          for (const part of candidate.content.parts) {
              if (part.inlineData && part.inlineData.data) {
                  const mime = part.inlineData.mimeType || 'image/png';
                  return `data:${mime};base64,${part.inlineData.data}`;
              }
          }
           // If no image found, check for text refusal/explanation
          const textPart = candidate.content.parts.find(p => p.text);
          if (textPart?.text) {
               throw new Error(textPart.text);
          }
      }
      handleGenerationError(candidate);
  }
  throw new Error('The model did not return an image.');
}

async function upscaleImage(
  base64Image: string,
  apiKey: string,
  aspectRatio: string,
): Promise<string> {
  const ai = new GoogleGenAI({apiKey});

  // Basic cleanup of base64 string to separate mime and data
  const match = base64Image.match(/^data:(image\/[a-z]+);base64,(.+)$/);
  if (!match) {
    throw new Error('Invalid image data found in source.');
  }
  const mimeType = match[1];
  const base64Data = match[2];

  // Uses Gemini 3 Pro Image Preview for high-res upscale
  const response = await ai.models.generateContent({
    model: 'gemini-3-pro-image-preview',
    contents: {
      parts: [
        {
          inlineData: {
            data: base64Data,
            mimeType: mimeType,
          },
        },
        {
          text: "Upscale this image to 4K resolution. Maintain high fidelity, enhance details, and keep the original composition.",
        },
      ],
    },
    config: {
      safetySettings: permissiveSafetySettings,
      imageConfig: {
        imageSize: '4K',
        aspectRatio: aspectRatio as any,
      },
    },
  });

  const candidate = response.candidates?.[0];
  if (candidate) {
      if (candidate.content?.parts) {
          for (const part of candidate.content.parts) {
              if (part.inlineData && part.inlineData.data) {
                  const mime = part.inlineData.mimeType || 'image/png';
                  return `data:${mime};base64,${part.inlineData.data}`;
              }
          }
          const textPart = candidate.content.parts.find(p => p.text);
          if (textPart?.text) {
               throw new Error(textPart.text);
          }
      }
      handleGenerationError(candidate);
  }
  throw new Error('The model did not return an image.');
}

async function remixImage(
  base64Image: string,
  remixPrompt: string,
  apiKey: string,
  aspectRatio: string,
  imageSize: ImageSize
): Promise<string> {
  const ai = new GoogleGenAI({apiKey});

  const match = base64Image.match(/^data:(image\/[a-z]+);base64,(.+)$/);
  if (!match) {
      throw new Error('Invalid image data found in source.');
  }
  const mimeType = match[1];
  const base64Data = match[2];

  // Uses Gemini 3 Pro Image Preview (Same as main generation) for Remix
  const response = await ai.models.generateContent({
      model: 'gemini-3-pro-image-preview',
      contents: {
          parts: [
              {
                  inlineData: {
                      data: base64Data,
                      mimeType: mimeType,
                  },
              },
              {
                  text: `Create a variation of this image based on this description: ${remixPrompt}`,
              },
          ],
      },
      config: {
          safetySettings: permissiveSafetySettings,
          imageConfig: {
              aspectRatio: aspectRatio as any,
              imageSize: imageSize
          }
      }
  });

  const candidate = response.candidates?.[0];
  if (candidate) {
      if (candidate.content?.parts) {
          for (const part of candidate.content.parts) {
              if (part.inlineData && part.inlineData.data) {
                  const mime = part.inlineData.mimeType || 'image/png';
                  return `data:${mime};base64,${part.inlineData.data}`;
              }
          }
          const textPart = candidate.content.parts.find(p => p.text);
          if (textPart?.text) {
               throw new Error(textPart.text);
          }
      }
      handleGenerationError(candidate);
  }
  throw new Error('The model did not return an image.');
}

// --- Video Generation Function ---
async function generateVideo(
    prompt: string,
    imageBase64: string | null,
    apiKey: string,
    aspectRatio: string,
    resolution: string
): Promise<string> {
    const ai = new GoogleGenAI({apiKey});
    
    // Select Model: fast for text-only, standard for image-to-video/shop mode high quality
    // 'veo-3.1-generate-preview' for Shop Mode (higher quality)
    // 'veo-3.1-fast-generate-preview' for Text-to-Video (speed)
    const model = imageBase64 ? 'veo-3.1-generate-preview' : 'veo-3.1-fast-generate-preview';
    
    // Ensure Aspect Ratio is valid for Veo (16:9 or 9:16 only)
    let safeAspectRatio = '16:9';
    if (aspectRatio === '9:16') safeAspectRatio = '9:16';
    
    const config: any = {
        numberOfVideos: 1,
        resolution: resolution as any,
        aspectRatio: safeAspectRatio as any
    };

    let operation;
    
    if (imageBase64) {
        // Shop Mode: Video from Image + Prompt
        const match = imageBase64.match(/^data:(image\/[a-z]+);base64,(.+)$/);
        if (!match) throw new Error('Invalid image data.');
        
        operation = await ai.models.generateVideos({
            model: model,
            prompt: prompt,
            image: {
                imageBytes: match[2],
                mimeType: match[1]
            },
            config: config
        });
    } else {
        // Standard Text-to-Video
        operation = await ai.models.generateVideos({
            model: model,
            prompt: prompt,
            config: config
        });
    }

    // Polling Loop
    showStatusMessage('Rendering video frames... (this may take a minute)');
    while (!operation.done) {
        await new Promise(resolve => setTimeout(resolve, 5000)); // Poll every 5s
        operation = await ai.operations.getVideosOperation({operation: operation});
    }

    const videoUri = operation.response?.generatedVideos?.[0]?.video?.uri;
    if (!videoUri) {
        throw new Error('Video generation completed but no URI returned.');
    }

    // Proxy the download to get a usable blob URL
    // Append API Key to the download link as per documentation
    const downloadResponse = await fetch(`${videoUri}&key=${apiKey}`);
    if (!downloadResponse.ok) {
        throw new Error(`Failed to download generated video: ${downloadResponse.statusText}`);
    }
    
    const videoBlob = await downloadResponse.blob();
    return URL.createObjectURL(videoBlob);
}

// --- Watermark Logic ---
async function applyWatermark(base64Image: string): Promise<string> {
    const toggle = document.getElementById('watermark-toggle') as HTMLInputElement;
    if (!toggle || !toggle.checked) return base64Image;

    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            if (!ctx) { resolve(base64Image); return; }

            // Draw original
            ctx.drawImage(img, 0, 0);

            // Settings
            const type = document.getElementById('wm-type-text')?.classList.contains('bg-blue-500/20') ? 'text' : 'image';
            const opacity = parseFloat((document.getElementById('wm-opacity') as HTMLInputElement).value);
            const position = (document.getElementById('wm-position') as HTMLSelectElement).value;
            const padding = img.width * 0.03; // 3% padding

            ctx.globalAlpha = opacity;

            if (type === 'text') {
                const text = (document.getElementById('wm-text') as HTMLInputElement).value || 'Watermark';
                const fontSize = img.width * 0.05; // 5% of width
                ctx.font = `bold ${fontSize}px sans-serif`;
                ctx.textBaseline = 'bottom';
                
                const metrics = ctx.measureText(text);
                const textWidth = metrics.width;
                const textHeight = fontSize; // Approximate

                let x = 0, y = 0;
                switch (position) {
                    case 'bottom-right': x = img.width - textWidth - padding; y = img.height - padding; break;
                    case 'bottom-left': x = padding; y = img.height - padding; break;
                    case 'top-right': x = img.width - textWidth - padding; y = padding + textHeight; break;
                    case 'top-left': x = padding; y = padding + textHeight; break;
                    case 'center': 
                        x = (img.width - textWidth) / 2; 
                        y = (img.height + textHeight) / 2; 
                        ctx.textBaseline = 'middle';
                        break;
                }

                // Shadow/Stroke for visibility
                ctx.shadowColor = "rgba(0,0,0,0.5)";
                ctx.shadowBlur = 4;
                ctx.fillStyle = "white";
                ctx.fillText(text, x, y);

            } else if (type === 'image' && watermarkLogoBase64) {
                 const logo = new Image();
                 logo.onload = () => {
                    const logoTargetWidth = img.width * 0.15; // 15% width
                    const scale = logoTargetWidth / logo.width;
                    const logoWidth = logo.width * scale;
                    const logoHeight = logo.height * scale;

                    let x = 0, y = 0;
                     switch (position) {
                        case 'bottom-right': x = img.width - logoWidth - padding; y = img.height - logoHeight - padding; break;
                        case 'bottom-left': x = padding; y = img.height - logoHeight - padding; break;
                        case 'top-right': x = img.width - logoWidth - padding; y = padding; break;
                        case 'top-left': x = padding; y = padding; break;
                        case 'center': x = (img.width - logoWidth) / 2; y = (img.height - logoHeight) / 2; break;
                    }

                    ctx.drawImage(logo, x, y, logoWidth, logoHeight);
                    resolve(canvas.toDataURL('image/png'));
                 };
                 logo.onerror = () => resolve(base64Image); // Fail safe
                 logo.src = watermarkLogoBase64;
                 return; // Wait for logo load
            }

            resolve(canvas.toDataURL('image/png'));
        };
        img.onerror = () => resolve(base64Image);
        img.src = base64Image;
    });
}


// --- DOM Element Selection ---
const promptEl = document.querySelector('#prompt-input') as HTMLTextAreaElement;
const generateButton = document.querySelector(
  '#generate-button',
) as HTMLButtonElement;
const generateButtonText = document.querySelector('#generate-button-text') as HTMLSpanElement;
const imageActionsContainer = document.querySelector(
  '#image-actions',
) as HTMLDivElement;
const downloadButton = document.querySelector(
  '#download-button',
) as HTMLButtonElement;
const upscaleButton = document.querySelector(
  '#upscale-button',
) as HTMLButtonElement;
const remixButton = document.querySelector(
  '#remix-button',
) as HTMLButtonElement;
const enhancePromptButton = document.querySelector(
  '#enhance-prompt-button',
) as HTMLButtonElement;
const outputImage = document.querySelector('#output-image') as HTMLImageElement;
const outputVideo = document.querySelector('#output-video') as HTMLVideoElement;
const historySection = document.querySelector(
  '#history-section',
) as HTMLDivElement;
const historyContainer = document.querySelector(
  '#history-container',
) as HTMLDivElement;
const imagePlaceholder = document.querySelector(
  '#image-placeholder',
) as HTMLDivElement;
const imageLoader = document.querySelector('#image-loader') as HTMLDivElement;
const loadingProgressBar = document.querySelector('#loading-progress-bar') as HTMLDivElement;

// Mode Selectors
const modeRadios = document.querySelectorAll('input[name="generation-mode"]');
const bulkHelperText = document.querySelector('#bulk-helper-text') as HTMLSpanElement;
const bulkResultsContainer = document.querySelector('#bulk-results-container') as HTMLDivElement;
const bulkList = document.querySelector('#bulk-list') as HTMLDivElement;
const bulkDownloadButton = document.querySelector('#bulk-download-button') as HTMLButtonElement;

// Media Switcher
const mediaIndicator = document.querySelector('#media-indicator') as HTMLDivElement;
const mediaImageBtn = document.querySelector('#media-image') as HTMLButtonElement;
const mediaVideoBtn = document.querySelector('#media-video') as HTMLButtonElement;
const currentMediaTypeInput = document.querySelector('#current-media-type') as HTMLInputElement;

// Controls Visibility Groups
const imageSizeControl = document.querySelector('#image-size-control') as HTMLDivElement;
const videoResControl = document.querySelector('#video-res-control') as HTMLDivElement;
const referenceUploadGroup = document.querySelector('#reference-upload-group') as HTMLDivElement;
const editSection = document.querySelector('#edit-section') as HTMLDivElement;
const arHelpText = document.querySelector('#ar-help-text') as HTMLSpanElement;


// Clothing Shop Controls
const garmentUploadSection = document.querySelector('#garment-upload-section') as HTMLDivElement;
const garmentImageUpload = document.querySelector('#garment-image-upload') as HTMLInputElement;
const garmentImagePreviewContainer = document.querySelector('#garment-image-preview-container') as HTMLDivElement;
const garmentImagePreview = document.querySelector('#garment-image-preview') as HTMLImageElement;
const clearGarmentImageButton = document.querySelector('#clear-garment-image') as HTMLButtonElement;

// Product Shop Controls
const productUploadSection = document.querySelector('#product-upload-section') as HTMLDivElement;
const productImageUpload = document.querySelector('#product-image-upload') as HTMLInputElement;
const productImagePreviewContainer = document.querySelector('#product-image-preview-container') as HTMLDivElement;
const productImagePreview = document.querySelector('#product-image-preview') as HTMLImageElement;
const clearProductImageButton = document.querySelector('#clear-product-image') as HTMLButtonElement;

// Nail Art Mode Controls
const nailUploadSection = document.querySelector('#nail-upload-section') as HTMLDivElement;
const nailImageUpload = document.querySelector('#nail-image-upload') as HTMLInputElement;
const nailImagePreviewContainer = document.querySelector('#nail-image-preview-container') as HTMLDivElement;
// nailImagePreview removed as we now use a list
const nailPreviewList = document.querySelector('#nail-preview-list') as HTMLDivElement;
const clearNailImageButton = document.querySelector('#clear-nail-image') as HTMLButtonElement;


// Reference Image Controls
const referenceImageUpload = document.querySelector('#reference-image-upload') as HTMLInputElement;
const referenceImagePreviewContainer = document.querySelector('#reference-image-preview-container') as HTMLDivElement;
const referenceImagePreview = document.querySelector('#reference-image-preview') as HTMLImageElement;
const clearReferenceImageButton = document.querySelector('#clear-reference-image') as HTMLButtonElement;
const uploadLabel = document.querySelector('label[for="reference-image-upload"]') as HTMLLabelElement;
const referenceImageLabel = document.querySelector('#reference-image-label') as HTMLLabelElement;
const referenceUploadText = document.querySelector('#reference-upload-text') as HTMLParagraphElement;
const referenceHelpText = document.querySelector('#reference-help-text') as HTMLParagraphElement;

// Negative Prompt Controls
const negativePromptToggle = document.querySelector('#negative-prompt-toggle') as HTMLButtonElement;
const negativePromptContainer = document.querySelector('#negative-prompt-container') as HTMLDivElement;
const negativePromptInput = document.querySelector('#negative-prompt-input') as HTMLInputElement;
const negToggleIcon = document.querySelector('#neg-toggle-icon') as SVGElement;


// Watermark Controls
const watermarkToggle = document.querySelector('#watermark-toggle') as HTMLInputElement;
const watermarkControls = document.querySelector('#watermark-controls') as HTMLDivElement;
const wmTypeText = document.querySelector('#wm-type-text') as HTMLButtonElement;
const wmTypeImage = document.querySelector('#wm-type-image') as HTMLButtonElement;
const wmTextInputContainer = document.querySelector('#wm-text-input-container') as HTMLDivElement;
const wmImageInputContainer = document.querySelector('#wm-image-input-container') as HTMLDivElement;
const wmImageUpload = document.querySelector('#wm-image-upload') as HTMLInputElement;
const wmFilename = document.querySelector('#wm-filename') as HTMLSpanElement;
const wmPreview = document.querySelector('#wm-preview') as HTMLImageElement;

// Edit Controls
const editPromptInput = document.querySelector(
  '#edit-prompt-input',
) as HTMLInputElement;
const editButton = document.querySelector('#edit-button') as HTMLButtonElement;

// --- State Variables ---
let prompt = '';
let referenceImageBase64: string | null = null;
let garmentImageBase64: string | null = null;
let productImageBase64: string | null = null;
let nailImageBase64s: string[] = []; // Array for bulk support
let watermarkLogoBase64: string | null = null;
let loadingInterval: number | undefined;
let progressInterval: number | undefined;

// Bulk State
type BulkItem = { id: string, prompt: string, status: 'pending'|'generating'|'done'|'error', imageUrl?: string };
let bulkQueue: BulkItem[] = [];

// --- Loading Animation ---
const loadingMessages = [
  'Generating your masterpiece...',
  'Summoning pixels from the digital ether...',
  'Painting with algorithms...',
  'Unleashing creative AI...',
  'This might take a moment...',
  'Crafting your vision...',
];

const videoLoadingMessages = [
    'Directing the scene...',
    'Rendering frames with Veo...',
    'Composing cinematic shots...',
    'Applying physics and lighting...',
    'Finalizing video output...',
    'Almost ready for the premiere...'
];

function updateProgressBar(percent: number) {
  if (loadingProgressBar) {
    loadingProgressBar.style.width = `${percent}%`;
  }
}

function startLoadingAnimation(isVideo = false) {
  const loadingTextEl = document.querySelector(
    '#loading-text',
  ) as HTMLParagraphElement;
  
  const messages = isVideo ? videoLoadingMessages : loadingMessages;
  
  // Reset Progress Bar
  updateProgressBar(0);

  // Set color for video vs image
  if (loadingProgressBar) {
      if (isVideo) {
          loadingProgressBar.classList.remove('from-blue-500', 'via-purple-500', 'to-pink-500');
          loadingProgressBar.classList.add('bg-purple-600', 'shadow-purple-500/50');
      } else {
          loadingProgressBar.classList.add('from-blue-500', 'via-purple-500', 'to-pink-500');
          loadingProgressBar.classList.remove('bg-purple-600', 'shadow-purple-500/50');
      }
  }

  if (loadingTextEl) {
      let messageIndex = 0;
      loadingTextEl.innerText = messages[messageIndex];
      
      // Cycle messages
      loadingInterval = window.setInterval(() => {
          messageIndex = (messageIndex + 1) % messages.length;
          loadingTextEl.innerText = messages[messageIndex];
      }, 4000);
  }

  // Simulate progress
  let progress = 0;
  progressInterval = window.setInterval(() => {
    // Slower progress for video
    const increment = isVideo ? Math.random() * 0.2 : Math.random() * 5;
    if (progress < 95) {
        progress += increment;
        updateProgressBar(progress);
    }
  }, 300);

  // UI Updates
  if(imageLoader) imageLoader.classList.remove('hidden');
  if(imagePlaceholder) imagePlaceholder.classList.add('hidden');
  if(outputImage) outputImage.classList.add('hidden');
  if(outputVideo) {
      outputVideo.classList.add('hidden');
      outputVideo.pause();
      outputVideo.src = "";
  }
  if(bulkResultsContainer) bulkResultsContainer.classList.add('hidden');
  if(imageActionsContainer) imageActionsContainer.classList.add('hidden');
  if(editSection) editSection.classList.add('hidden');
  
  showStatusMessage(isVideo ? 'Processing video request...' : 'Processing request...');
  
  if(generateButton) {
      generateButton.disabled = true;
      generateButton.classList.add('opacity-50', 'cursor-not-allowed');
  }
}

function stopLoadingAnimation() {
  if (loadingInterval) clearInterval(loadingInterval);
  if (progressInterval) clearInterval(progressInterval);
  updateProgressBar(100);
  
  if(imageLoader) imageLoader.classList.add('hidden');
  if(generateButton) {
      generateButton.disabled = false;
      generateButton.classList.remove('opacity-50', 'cursor-not-allowed');
  }
  if(statusEl) statusEl.innerText = '';
}

// --- File Handling ---
function handleFileUpload(
    file: File, 
    previewEl: HTMLImageElement, 
    containerEl: HTMLDivElement, 
    callback: (base64: string) => void
) {
    if (file) {
        const reader = new FileReader();
        reader.onload = async (e) => {
            if (e.target?.result) {
                let result = e.target.result as string;
                // Compress/Resize input image to avoid payload limits (max 1536px)
                try {
                    result = await compressImage(result, 1536, 0.85);
                } catch (err) {
                    console.warn("Failed to resize input image, using original", err);
                }
                
                if(previewEl) previewEl.src = result;
                if(containerEl) containerEl.classList.remove('hidden');
                callback(result);
            }
        };
        reader.readAsDataURL(file);
    }
}

// --- History Management ---
async function saveToHistory(prompt: string, imageUrl: string) {
    try {
        // Compress the image before saving to avoid LocalStorage quota limits
        // Use JPEG format and reduce size
        const compressedUrl = await compressImage(imageUrl, 800, 0.7);

        const history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
        
        // Add new item to start
        const newItem = { prompt, imageUrl: compressedUrl };
        let newHistory = [newItem, ...history].slice(0, MAX_HISTORY_ITEMS);
        
        // Attempt to save, handling quota errors by reducing history size if needed
        try {
            localStorage.setItem(HISTORY_KEY, JSON.stringify(newHistory));
        } catch (e: any) {
            if (e.name === 'QuotaExceededError' || e.code === 22) {
                console.warn("Storage quota exceeded. Removing oldest items...");
                while (newHistory.length > 1) {
                    newHistory.pop(); // Remove oldest
                    try {
                        localStorage.setItem(HISTORY_KEY, JSON.stringify(newHistory));
                        // If success, break loop
                        break;
                    } catch (e2) {
                         // Still failing, continue loop
                         continue;
                    }
                }
            } else {
                console.error("Storage error:", e);
            }
        }
        
        renderHistory();
    } catch (error) {
        console.error("Failed to process image for history:", error);
    }
}

function loadFromHistory() {
    renderHistory();
}

function renderHistory() {
    const history = JSON.parse(
      localStorage.getItem(HISTORY_KEY) || '[]',
    ) as HistoryItem[];
    if (history.length === 0) {
      if (historySection) historySection.classList.add('hidden');
      return;
    }
    if (historySection) historySection.classList.remove('hidden');
    if (historyContainer) historyContainer.innerHTML = '';

    history.forEach((item) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'flex-shrink-0 w-32 h-32 relative group cursor-pointer overflow-hidden rounded-lg border border-gray-700';
      
      const img = document.createElement('img');
      img.src = item.imageUrl;
      img.alt = item.prompt;
      img.className = 'w-full h-full object-cover transition-transform duration-300 group-hover:scale-110';
      
      const overlay = document.createElement('div');
      overlay.className = 'absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center p-2 text-center';
      
      const span = document.createElement('span');
      span.className = 'text-[10px] text-white font-medium line-clamp-2 mb-1';
      span.innerText = item.prompt;

      // Download button for history item
      const dlBtn = document.createElement('button');
      dlBtn.className = 'p-1 bg-white/10 hover:bg-white/20 rounded-full text-white';
      dlBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>';
      dlBtn.onclick = (e) => {
          e.stopPropagation();
          const link = document.createElement('a');
          link.href = item.imageUrl;
          link.download = `gemini-history-${Date.now()}.jpg`;
          link.click();
      };

      overlay.appendChild(span);
      overlay.appendChild(dlBtn);
      wrapper.appendChild(img);
      wrapper.appendChild(overlay);

      wrapper.onclick = () => {
        // Switch to Image mode view when loading history
        updateMediaTypeUI('image');
        if(outputImage) {
            outputImage.src = item.imageUrl;
            outputImage.classList.remove('hidden');
        }
        if(outputVideo) outputVideo.classList.add('hidden');
        if(imagePlaceholder) imagePlaceholder.classList.add('hidden');
        if(bulkResultsContainer) bulkResultsContainer.classList.add('hidden');
        if(imageActionsContainer) imageActionsContainer.classList.remove('hidden');
        if(editSection) editSection.classList.remove('hidden');
        if(promptEl) promptEl.value = item.prompt;
        showStatusMessage('Loaded from history.');
      };

      if (historyContainer) historyContainer.appendChild(wrapper);
    });
}

// --- UI Logic helpers ---
function updateMediaTypeUI(type: MediaType) {
    if(currentMediaTypeInput) currentMediaTypeInput.value = type;
    
    // Animate Switch
    if (type === 'image') {
        if(mediaIndicator) mediaIndicator.style.transform = 'translateX(0%)';
        if(mediaImageBtn) {
            mediaImageBtn.classList.remove('text-gray-400');
            mediaImageBtn.classList.add('text-white');
        }
        if(mediaVideoBtn) {
            mediaVideoBtn.classList.add('text-gray-400');
            mediaVideoBtn.classList.remove('text-white');
        }
        
        // Show Image Modes
        document.querySelectorAll('.image-mode').forEach(el => el.classList.remove('hidden'));
        document.querySelectorAll('.video-mode').forEach(el => el.classList.add('hidden'));
        
        // Reset to default Image Mode
        const std = document.querySelector('#mode-standard') as HTMLInputElement;
        if(std) std.checked = true;
        
        // Show Image Controls
        if(imageSizeControl) imageSizeControl.classList.remove('hidden');
        if(videoResControl) videoResControl.classList.add('hidden');
        if(referenceUploadGroup) referenceUploadGroup.classList.remove('hidden');
        if(editSection) editSection.classList.remove('hidden');
        if(generateButtonText) generateButtonText.innerText = "Generate Artwork";
        if(promptEl) promptEl.placeholder = "Describe your imagination...";
        if(arHelpText) arHelpText.classList.add('hidden');
        
        // Restore AR options
        document.querySelectorAll('.ar-option').forEach((el: any) => {
             el.classList.remove('opacity-30', 'pointer-events-none');
        });

    } else {
        if(mediaIndicator) mediaIndicator.style.transform = 'translateX(102%)'; // Adjust for gap
        if(mediaVideoBtn) {
            mediaVideoBtn.classList.remove('text-gray-400');
            mediaVideoBtn.classList.add('text-white');
        }
        if(mediaImageBtn) {
            mediaImageBtn.classList.add('text-gray-400');
            mediaImageBtn.classList.remove('text-white');
        }
        
        // Show Video Modes
        document.querySelectorAll('.image-mode').forEach(el => el.classList.add('hidden'));
        document.querySelectorAll('.video-mode').forEach(el => el.classList.remove('hidden'));
        
        // Reset to default Video Mode
        const stdVid = document.querySelector('#mode-video-standard') as HTMLInputElement;
        if(stdVid) stdVid.checked = true;

        // Show Video Controls
        if(imageSizeControl) imageSizeControl.classList.add('hidden');
        if(videoResControl) videoResControl.classList.remove('hidden');
        if(referenceUploadGroup) referenceUploadGroup.classList.add('hidden'); // No generic ref for video yet
        if(editSection) editSection.classList.add('hidden'); // No edit for video
        if(generateButtonText) generateButtonText.innerText = "Generate Video";
        if(promptEl) promptEl.placeholder = "Describe a cinematic scene with movement, lighting, and action...";
        if(arHelpText) arHelpText.classList.remove('hidden');

        // Limit AR options (Veo only supports 16:9 and 9:16)
        document.querySelectorAll('.ar-option').forEach((el: any) => {
            const ratio = el.querySelector('input').value;
            if (ratio !== '16:9' && ratio !== '9:16') {
                 el.classList.add('opacity-30', 'pointer-events-none');
            } else {
                 el.classList.remove('opacity-30', 'pointer-events-none');
            }
        });
        
        // Select a valid AR if invalid one is checked
        const currentAR = (document.querySelector('input[name="aspect-ratio"]:checked') as HTMLInputElement)?.value;
        if (currentAR !== '16:9' && currentAR !== '9:16') {
             const ar169 = document.querySelector('#ratio-16-9') as HTMLInputElement;
             if(ar169) ar169.checked = true;
        }
        
        // Hide image specific upload sections
        if(garmentUploadSection) garmentUploadSection.classList.add('hidden');
        if(productUploadSection) productUploadSection.classList.add('hidden');
        if(nailUploadSection) nailUploadSection.classList.add('hidden');
        if(bulkHelperText) bulkHelperText.classList.add('hidden');
    }
    
    // Clear outputs
    if(imagePlaceholder) imagePlaceholder.classList.remove('hidden');
    if(outputImage) outputImage.classList.add('hidden');
    if(outputVideo) outputVideo.classList.add('hidden');
    if(bulkResultsContainer) bulkResultsContainer.classList.add('hidden');
    if(imageActionsContainer) imageActionsContainer.classList.add('hidden');
}

// --- Bulk Generation Logic ---
async function runBulkGeneration(prompts: string[], apiKey: string, aspectRatio: string, imageSize: ImageSize, negativePrompt: string) {
    bulkQueue = prompts.map((p, i) => ({
        id: `bulk-${Date.now()}-${i}`,
        prompt: p.trim(),
        status: 'pending'
    }));

    if(imagePlaceholder) imagePlaceholder.classList.add('hidden');
    if(outputImage) outputImage.classList.add('hidden');
    if(bulkResultsContainer) bulkResultsContainer.classList.remove('hidden');
    if(bulkList) bulkList.innerHTML = '';
    if(bulkDownloadButton) bulkDownloadButton.classList.add('hidden');

    // Render Initial List
    bulkQueue.forEach(item => {
        const row = document.createElement('div');
        row.id = item.id;
        row.className = 'bg-[#1c1e21] rounded-lg p-3 flex items-center gap-4 border border-gray-700';
        row.innerHTML = `
            <div class="w-16 h-16 bg-black/50 rounded flex-shrink-0 flex items-center justify-center border border-gray-600 overflow-hidden">
                <span class="text-xs text-gray-500 status-icon">...</span>
                <img class="hidden w-full h-full object-cover" />
            </div>
            <div class="flex-1 min-w-0">
                <p class="text-sm text-gray-300 truncate font-medium">${item.prompt}</p>
                <p class="text-xs text-gray-500 status-text">Pending</p>
            </div>
        `;
        bulkList.appendChild(row);
    });

    if(generateButton) {
        generateButton.disabled = true;
        generateButton.classList.add('opacity-50', 'cursor-not-allowed');
    }

    // Process Loop
    for (let i = 0; i < bulkQueue.length; i++) {
        const item = bulkQueue[i];
        const row = document.getElementById(item.id);
        if (!row) continue;

        const statusText = row.querySelector('.status-text') as HTMLElement;
        const statusIcon = row.querySelector('.status-icon') as HTMLElement;
        const imgEl = row.querySelector('img') as HTMLImageElement;

        // Update UI to Generating
        item.status = 'generating';
        statusText.innerText = 'Generating...';
        statusText.classList.add('text-blue-400', 'animate-pulse');
        row.classList.add('border-blue-500/50');

        try {
            // Apply Negative Prompt to each item if set
            let finalPrompt = item.prompt;
            if (negativePrompt) {
                finalPrompt += ` . Ensure the image does not contain: ${negativePrompt}.`;
            }

            // Generate
            let base64 = await generateImage(finalPrompt, apiKey, imageSize, aspectRatio);
            
            // Apply Watermark if enabled
            base64 = await applyWatermark(base64);

            // Success
            item.status = 'done';
            item.imageUrl = base64;
            
            // Update UI
            statusText.innerText = 'Completed';
            statusText.classList.remove('text-blue-400', 'animate-pulse');
            statusText.classList.add('text-green-400');
            row.classList.remove('border-blue-500/50');
            row.classList.add('border-green-500/30');
            
            if (imgEl) {
                imgEl.src = base64;
                imgEl.classList.remove('hidden');
            }
            if (statusIcon) statusIcon.classList.add('hidden');

            // Save to history individually
            await saveToHistory(`Bulk: ${item.prompt}`, base64);

        } catch (error) {
            // Error
            item.status = 'error';
            statusText.innerText = 'Failed';
            statusText.classList.remove('text-blue-400', 'animate-pulse');
            statusText.classList.add('text-red-400');
            row.classList.remove('border-blue-500/50');
            row.classList.add('border-red-500/30');
            if (statusIcon) statusIcon.innerText = '❌';
            console.error(error);
        }

        // Rate Limiting Delay (prevent 429)
        if (i < bulkQueue.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }

    // Finished
    if(generateButton) {
        generateButton.disabled = false;
        generateButton.classList.remove('opacity-50', 'cursor-not-allowed');
    }
    
    // Check if any success to show download all
    const hasSuccess = bulkQueue.some(item => item.status === 'done' && item.imageUrl);
    if (hasSuccess && bulkDownloadButton) {
        bulkDownloadButton.classList.remove('hidden');
    }
}

async function downloadBulkZip() {
    if (!window.JSZip) {
        alert("JSZip library not loaded.");
        return;
    }

    const zip = new window.JSZip();
    const folder = zip.folder("gemini-bulk-images");

    let count = 0;
    bulkQueue.forEach((item, index) => {
        if (item.status === 'done' && item.imageUrl) {
             const match = item.imageUrl.match(/^data:(image\/[a-z]+);base64,(.+)$/);
             if (match) {
                 const ext = match[1].split('/')[1];
                 const filename = `image_${index + 1}_${item.prompt.substring(0, 15).replace(/[^a-z0-9]/gi, '_')}.${ext}`;
                 folder.file(filename, match[2], {base64: true});
                 count++;
             }
        }
    });

    if (count > 0) {
        const content = await zip.generateAsync({type: "blob"});
        const url = URL.createObjectURL(content);
        const link = document.createElement('a');
        link.href = url;
        link.download = `gemini-bulk-${Date.now()}.zip`;
        link.click();
        URL.revokeObjectURL(url);
    } else {
        alert("No successful images to download.");
    }
}


// --- Event Listeners ---

// Media Switcher
if(mediaImageBtn) mediaImageBtn.addEventListener('click', () => updateMediaTypeUI('image'));
if(mediaVideoBtn) mediaVideoBtn.addEventListener('click', () => updateMediaTypeUI('video'));

// Negative Prompt Toggle
if(negativePromptToggle) {
    negativePromptToggle.addEventListener('click', () => {
        if(negativePromptContainer) {
            if (negativePromptContainer.classList.contains('hidden')) {
                negativePromptContainer.classList.remove('hidden');
                // Rotate Icon
                if(negToggleIcon) negToggleIcon.style.transform = "rotate(180deg)";
            } else {
                negativePromptContainer.classList.add('hidden');
                if(negToggleIcon) negToggleIcon.style.transform = "rotate(0deg)";
            }
        }
    });
}

// Mode Switching Logic
modeRadios.forEach((radio) => {
    radio.addEventListener('change', (e) => {
        const mode = (e.target as HTMLInputElement).value as GenMode;
        
        // Reset specific uploads when switching
        if(garmentUploadSection) garmentUploadSection.classList.add('hidden');
        if(productUploadSection) productUploadSection.classList.add('hidden');
        if(nailUploadSection) nailUploadSection.classList.add('hidden');
        if(bulkHelperText) bulkHelperText.classList.add('hidden');
        if(bulkResultsContainer) bulkResultsContainer.classList.add('hidden');

        // Reset Reference Label defaults
        if(referenceImageLabel) referenceImageLabel.innerText = "Reference Image";
        if(referenceUploadText) referenceUploadText.innerText = "Upload reference photo";
        if(referenceHelpText) referenceHelpText.innerText = "Upload a photo to transform it or use your face.";

        if (mode === 'clothing') {
            if(garmentUploadSection) garmentUploadSection.classList.remove('hidden');
            if(referenceImageLabel) referenceImageLabel.innerText = "Model / Person";
            if(referenceUploadText) referenceUploadText.innerText = "Upload person photo";
            if(referenceHelpText) referenceHelpText.innerText = "Upload the person who will wear the garment.";
        } else if (mode === 'product' || mode === 'video-shop') {
            if(productUploadSection) productUploadSection.classList.remove('hidden');
            if(referenceImageLabel) referenceImageLabel.innerText = "Background / Scene";
            if(referenceUploadText) referenceUploadText.innerText = "Upload background";
            if(referenceHelpText) referenceHelpText.innerText = "Upload a scene to place the product in (optional).";
        } else if (mode === 'nail') {
            if(nailUploadSection) nailUploadSection.classList.remove('hidden');
             if(referenceUploadGroup) referenceUploadGroup.classList.add('hidden');
        } else if (mode === 'bulk') {
             if(bulkHelperText) bulkHelperText.classList.remove('hidden');
             if(promptEl) promptEl.placeholder = "Enter prompt 1\nEnter prompt 2\nEnter prompt 3...";
             if(referenceUploadGroup) referenceUploadGroup.classList.add('hidden');
             if(editSection) editSection.classList.add('hidden');
        } else {
             if(referenceUploadGroup) referenceUploadGroup.classList.remove('hidden');
             if(editSection) editSection.classList.remove('hidden');
             if(promptEl) promptEl.placeholder = "Describe your imagination...";
        }
    });
});

if (referenceImageUpload) {
    referenceImageUpload.addEventListener('change', (event) => {
        const file = (event.target as HTMLInputElement).files?.[0];
        if (file) {
            handleFileUpload(file, referenceImagePreview, referenceImagePreviewContainer, (base64) => {
                referenceImageBase64 = base64;
                if(uploadLabel) uploadLabel.classList.add('hidden');
            });
        }
    });
}

if (garmentImageUpload) {
    garmentImageUpload.addEventListener('change', (event) => {
        const file = (event.target as HTMLInputElement).files?.[0];
        if (file) {
            handleFileUpload(file, garmentImagePreview, garmentImagePreviewContainer, (base64) => {
                garmentImageBase64 = base64;
            });
        }
    });
}

if (productImageUpload) {
    productImageUpload.addEventListener('change', (event) => {
        const file = (event.target as HTMLInputElement).files?.[0];
        if (file) {
            handleFileUpload(file, productImagePreview, productImagePreviewContainer, (base64) => {
                productImageBase64 = base64;
            });
        }
    });
}

// Updated Nail Upload Listener for Bulk
if (nailImageUpload) {
    nailImageUpload.addEventListener('change', async (event) => {
        const files = (event.target as HTMLInputElement).files;
        if (files && files.length > 0) {
            nailImageBase64s = [];
            if(nailPreviewList) nailPreviewList.innerHTML = '';
            
            // Process each file
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                const reader = new FileReader();
                
                await new Promise<void>((resolve) => {
                    reader.onload = async (e) => {
                         if (e.target?.result) {
                            let result = e.target.result as string;
                            try {
                                result = await compressImage(result, 1536, 0.85);
                            } catch (err) {
                                console.warn("Failed to resize", err);
                            }
                            
                            nailImageBase64s.push(result);
                            
                            // Create thumbnail
                            if(nailPreviewList) {
                                const img = document.createElement('img');
                                img.src = result;
                                img.className = 'h-full w-auto object-contain rounded border border-gray-600';
                                nailPreviewList.appendChild(img);
                            }
                         }
                         resolve();
                    };
                    reader.readAsDataURL(file);
                });
            }

            if (nailImageBase64s.length > 0) {
                 if(nailImagePreviewContainer) nailImagePreviewContainer.classList.remove('hidden');
            }
        }
    });
}

if (wmImageUpload) {
    wmImageUpload.addEventListener('change', (event) => {
        const file = (event.target as HTMLInputElement).files?.[0];
        if (file) {
            wmFilename.innerText = file.name;
            const reader = new FileReader();
            reader.onload = (e) => {
                if (e.target?.result) {
                    watermarkLogoBase64 = e.target.result as string;
                    wmPreview.src = watermarkLogoBase64;
                    wmPreview.classList.remove('hidden');
                }
            };
            reader.readAsDataURL(file);
        }
    });
}

// Watermark UI Event Listeners
if (watermarkToggle) {
    watermarkToggle.addEventListener('change', (e) => {
        if(watermarkControls) {
            if ((e.target as HTMLInputElement).checked) {
                watermarkControls.classList.remove('hidden');
            } else {
                watermarkControls.classList.add('hidden');
            }
        }
    });
}

if (wmTypeText) {
    wmTypeText.addEventListener('click', () => {
        wmTypeText.classList.add('bg-blue-500/20', 'text-blue-400', 'border', 'border-blue-500/50');
        wmTypeText.classList.remove('text-gray-400');
        wmTypeImage.classList.remove('bg-blue-500/20', 'text-blue-400', 'border', 'border-blue-500/50');
        wmTypeImage.classList.add('text-gray-400');
        
        wmTextInputContainer.classList.remove('hidden');
        wmImageInputContainer.classList.add('hidden');
    });
}

if (wmTypeImage) {
    wmTypeImage.addEventListener('click', () => {
        wmTypeImage.classList.add('bg-blue-500/20', 'text-blue-400', 'border', 'border-blue-500/50');
        wmTypeImage.classList.remove('text-gray-400');
        wmTypeText.classList.remove('bg-blue-500/20', 'text-blue-400', 'border', 'border-blue-500/50');
        wmTypeText.classList.add('text-gray-400');
        
        wmImageInputContainer.classList.remove('hidden');
        wmTextInputContainer.classList.add('hidden');
    });
}

if (clearReferenceImageButton) {
    clearReferenceImageButton.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        referenceImageBase64 = null;
        if(referenceImagePreview) referenceImagePreview.src = '';
        if(referenceImagePreviewContainer) referenceImagePreviewContainer.classList.add('hidden');
        if(referenceImageUpload) referenceImageUpload.value = '';
        if(uploadLabel) uploadLabel.classList.remove('hidden');
    });
}

if (clearGarmentImageButton) {
    clearGarmentImageButton.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        garmentImageBase64 = null;
        if(garmentImagePreview) garmentImagePreview.src = '';
        if(garmentImagePreviewContainer) garmentImagePreviewContainer.classList.add('hidden');
        if(garmentImageUpload) garmentImageUpload.value = '';
    });
}

if (clearProductImageButton) {
    clearProductImageButton.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        productImageBase64 = null;
        if(productImagePreview) productImagePreview.src = '';
        if(productImagePreviewContainer) productImagePreviewContainer.classList.add('hidden');
        if(productImageUpload) productImageUpload.value = '';
    });
}

if (clearNailImageButton) {
    clearNailImageButton.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        nailImageBase64s = [];
        if(nailPreviewList) nailPreviewList.innerHTML = '';
        if(nailImagePreviewContainer) nailImagePreviewContainer.classList.add('hidden');
        if(nailImageUpload) nailImageUpload.value = '';
    });
}

if (enhancePromptButton) {
    enhancePromptButton.addEventListener('click', async () => {
        const currentPrompt = promptEl.value.trim();
        if (!currentPrompt) {
            showStatusError('Please enter a prompt to enhance.');
            return;
        }

        const apiKey = process.env.API_KEY;
        if (!apiKey) {
        await openApiKeyDialog();
        return;
        }

        try {
            enhancePromptButton.classList.add('loading');
            enhancePromptButton.disabled = true;
            
            const enhanced = await enhancePrompt(currentPrompt, apiKey);
            promptEl.value = enhanced;
        } catch (error: any) {
            console.error(error);
            showStatusError('Failed to enhance prompt: ' + error.message);
        } finally {
            enhancePromptButton.classList.remove('loading');
            enhancePromptButton.disabled = false;
        }
    });
}

if (bulkDownloadButton) {
    bulkDownloadButton.addEventListener('click', downloadBulkZip);
}

if (generateButton) {
    generateButton.addEventListener('click', async () => {
    prompt = promptEl.value;
    const negativePrompt = negativePromptInput.value.trim();
    const currentMode = (document.querySelector('input[name="generation-mode"]:checked') as HTMLInputElement)?.value as GenMode || 'standard';
    const mediaType = currentMediaTypeInput.value as MediaType;

    const apiKey = process.env.API_KEY;
    if (!apiKey) {
        await openApiKeyDialog();
        return;
    }

    const imageSize = (document.querySelector('input[name="image-size"]:checked') as HTMLInputElement)?.value as ImageSize || '1K';
    const aspectRatio = (document.querySelector('input[name="aspect-ratio"]:checked') as HTMLInputElement)?.value || '1:1';
    const videoRes = (document.querySelector('input[name="video-res"]:checked') as HTMLInputElement)?.value || '1080p';

    // SPECIAL HANDLING FOR BULK MODE
    if (currentMode === 'bulk') {
        const prompts = prompt.split('\n').map(p => p.trim()).filter(p => p.length > 0);
        if (prompts.length === 0) {
            showStatusError('Please enter at least one prompt for bulk generation.');
            return;
        }
        await runBulkGeneration(prompts, apiKey, aspectRatio, imageSize, negativePrompt);
        return; // Exit normal flow
    }

    // Validation for other modes
    if (!prompt && !referenceImageBase64 && !garmentImageBase64 && !productImageBase64 && nailImageBase64s.length === 0) {
        showStatusError('Please enter a prompt or upload an image.');
        return;
    }
    
    if (currentMode === 'clothing' && !garmentImageBase64) {
        showStatusError('Please upload a garment image for Clothing Shop Mode.');
        return;
    }

    if ((currentMode === 'product' || currentMode === 'video-shop') && !productImageBase64) {
        showStatusError('Please upload a product image for Product Shop Mode.');
        return;
    }

    if (currentMode === 'nail' && nailImageBase64s.length === 0) {
        showStatusError('Please upload a hand reference image for Nail Art Mode.');
        return;
    }

    startLoadingAnimation(mediaType === 'video');

    try {
        if (mediaType === 'video') {
            // VIDEO GENERATION
            let videoUrl: string;
            
            let finalVideoPrompt = prompt;
            if(negativePrompt) {
                finalVideoPrompt += ` . Ensure the video does not contain: ${negativePrompt}.`;
            }

            if (currentMode === 'video-shop') {
                // Shop Mode (Image to Video)
                if (!productImageBase64) throw new Error('Product image required.');
                const shopPrompt = `Cinematic product showcase video. ${finalVideoPrompt}. High production value, professional lighting.`;
                videoUrl = await generateVideo(shopPrompt, productImageBase64, apiKey, aspectRatio, videoRes);
            } else {
                // Standard Text to Video
                videoUrl = await generateVideo(finalVideoPrompt, null, apiKey, aspectRatio, videoRes);
            }

            if(outputVideo) {
                outputVideo.src = videoUrl;
                outputVideo.classList.remove('hidden');
                outputVideo.play();
            }
            if(imagePlaceholder) imagePlaceholder.classList.add('hidden');
            if(outputImage) outputImage.classList.add('hidden');
            if(imageActionsContainer) imageActionsContainer.classList.remove('hidden');
            
            // Hide unsupported actions for video
            if (upscaleButton) upscaleButton.parentElement?.classList.add('hidden'); 
            if (remixButton) remixButton.parentElement?.classList.add('hidden'); 
            // We repurpose download button or hide others. 
            // Simplified: Hide Upscale/Remix for video in UI logic
            if(upscaleButton) upscaleButton.classList.add('hidden');
            if(remixButton) remixButton.classList.add('hidden');
            
        } else {
            // IMAGE GENERATION
            let base64Image: string;
            
            // Append Negative Prompt logic for single generation
            let finalPrompt = prompt;
            if(negativePrompt) {
                finalPrompt += ` . Ensure the image does not contain: ${negativePrompt}.`;
            }

            // Determine Generation Strategy
            if (currentMode === 'clothing' && garmentImageBase64 && referenceImageBase64) {
                // Mode 1: Virtual Try-On / Clothing Shop (Nano Banana)
                const inputs = [
                    { data: referenceImageBase64.split(',')[1], mimeType: referenceImageBase64.split(';')[0].split(':')[1] },
                    { data: garmentImageBase64.split(',')[1], mimeType: garmentImageBase64.split(';')[0].split(':')[1] }
                ];
                
                let tryOnPrompt = "Fashion photography: model wearing the garment.";
                if (finalPrompt) {
                    tryOnPrompt += ` Context: ${finalPrompt}`;
                }

                base64Image = await generateMultimodalImage(tryOnPrompt, inputs, apiKey, aspectRatio);

            } else if (currentMode === 'product' && productImageBase64) {
                // Mode 2: Product Shop (Nano Banana)
                const inputs = [];
                // If background reference exists, it's the scene.
                if (referenceImageBase64) {
                    inputs.push({ data: productImageBase64.split(',')[1], mimeType: productImageBase64.split(';')[0].split(':')[1] });
                    inputs.push({ data: referenceImageBase64.split(',')[1], mimeType: referenceImageBase64.split(';')[0].split(':')[1] });
                    
                    let prodPrompt = "Professional product photography. Place the product [Image 1] into the scene [Image 2] naturally.";
                    if (finalPrompt) prodPrompt += ` ${finalPrompt}`;
                    
                    base64Image = await generateMultimodalImage(prodPrompt, inputs, apiKey, aspectRatio);
                } else {
                    // Product + Prompt only
                    inputs.push({ data: productImageBase64.split(',')[1], mimeType: productImageBase64.split(';')[0].split(':')[1] });
                    let prodPrompt = "Professional product photography of this item.";
                    if (finalPrompt) prodPrompt += ` Context: ${finalPrompt}`;
                    
                    base64Image = await generateMultimodalImage(prodPrompt, inputs, apiKey, aspectRatio);
                }
            } else if (currentMode === 'nail' && nailImageBase64s.length > 0) {
                // Mode 5: Nail Art Mode (Nano Banana) - Supports Bulk
                
                let nailPrompt = "Professional nail art photography. Apply the design described to the fingernails in the image. Keep the hand pose, skin tone, and fingers natural.";
                if (finalPrompt) nailPrompt += ` Design: ${finalPrompt}`;
                else nailPrompt += ` Design: Artistic and trendy nail polish pattern.`;
                
                let lastGeneratedImage = "";

                // Process each image in the bulk list
                for (let i = 0; i < nailImageBase64s.length; i++) {
                    const currentBase64 = nailImageBase64s[i];
                    
                    // Update status if multiple
                    if (nailImageBase64s.length > 1) {
                         showStatusMessage(`Processing image ${i + 1} of ${nailImageBase64s.length}...`);
                    }

                    const inputs = [
                        { data: currentBase64.split(',')[1], mimeType: currentBase64.split(';')[0].split(':')[1] }
                    ];
                    
                    let result = await generateMultimodalImage(nailPrompt, inputs, apiKey, aspectRatio);
                    
                    // Apply Watermark here for Bulk flow before saving intermediate history
                    result = await applyWatermark(result);
                    
                    lastGeneratedImage = result;

                    // If it's NOT the last one, save it to history immediately so user sees progress in filmstrip
                    if (i < nailImageBase64s.length - 1) {
                         await saveToHistory(`Nail Art Bulk ${i+1}/${nailImageBase64s.length}`, result);
                    }
                }
                
                // Assign the last one to base64Image so the standard flow below handles display and final save
                base64Image = lastGeneratedImage;

            } else if (referenceImageBase64) {
                // Mode 3: Image Variation / Reference based (Standard Mode but with Ref)
                const inputs = [
                    { data: referenceImageBase64.split(',')[1], mimeType: referenceImageBase64.split(';')[0].split(':')[1] }
                ];
                const refPrompt = finalPrompt ? finalPrompt : "High quality image variation.";
                base64Image = await generateMultimodalImage(refPrompt, inputs, apiKey, aspectRatio);

            } else {
                // Mode 4: Text to Image (Gemini 3 Pro)
                base64Image = await generateImage(finalPrompt, apiKey, imageSize, aspectRatio);
            }
            
            // Apply Watermark (Standard Flow)
            base64Image = await applyWatermark(base64Image);

            if(outputImage) {
                outputImage.src = base64Image;
                outputImage.classList.remove('hidden');
            }
            if(outputVideo) outputVideo.classList.add('hidden');
            if(outputVideo) outputVideo.pause();
            
            // Show Image Actions
            if(imageActionsContainer) imageActionsContainer.classList.remove('hidden');
            if(upscaleButton) upscaleButton.classList.remove('hidden');
            if(remixButton) remixButton.classList.remove('hidden');

            // Save to history with compression
            let historyPrompt = prompt || "Image Generation";
            if (currentMode === 'clothing') historyPrompt = "Virtual Try-On";
            if (currentMode === 'product') historyPrompt = "Product Shot";
            if (currentMode === 'nail') historyPrompt = "Nail Art";
            
            await saveToHistory(historyPrompt, base64Image);
        }

    } catch (error: any) {
        console.error(error);
        showStatusError(error.message);
    } finally {
        stopLoadingAnimation();
    }
    });
}

if (editButton) {
    editButton.addEventListener('click', async () => {
    const editPrompt = editPromptInput.value;
    const negativePrompt = negativePromptInput.value.trim();

    if (!editPrompt) {
        showStatusError('Please enter instruction for editing.');
        return;
    }
    if (!outputImage.src || outputImage.classList.contains('hidden')) {
        showStatusError('No image to edit. Generate one first.');
        return;
    }

    const apiKey = process.env.API_KEY;
    if (!apiKey) {
        await openApiKeyDialog();
        return;
    }

    startLoadingAnimation();

    try {
        let finalEditPrompt = editPrompt;
        if(negativePrompt) {
            finalEditPrompt += ` . Ensure the image does not contain: ${negativePrompt}.`;
        }

        let newImage = await editImage(outputImage.src, finalEditPrompt, apiKey);
        
        // Apply Watermark
        newImage = await applyWatermark(newImage);

        if(outputImage) {
            outputImage.src = newImage;
            outputImage.classList.remove('hidden');
        }
        if(imageActionsContainer) imageActionsContainer.classList.remove('hidden');
        
        await saveToHistory(`Edit: ${editPrompt}`, newImage);
        if(editPromptInput) editPromptInput.value = ''; // Clear input after success
    } catch (error: any) {
        console.error(error);
        showStatusError(error.message);
    } finally {
        stopLoadingAnimation();
    }
    });
}

if (downloadButton) {
    downloadButton.addEventListener('click', () => {
        const mediaType = currentMediaTypeInput.value;
        
        if (mediaType === 'video' && outputVideo.src && !outputVideo.classList.contains('hidden')) {
             const link = document.createElement('a');
             link.href = outputVideo.src;
             link.download = `veo-video-${Date.now()}.mp4`;
             link.click();
        } else if (outputImage.src && !outputImage.classList.contains('hidden')) {
            const link = document.createElement('a');
            link.href = outputImage.src;
            link.download = `gemini-gen-${Date.now()}.png`;
            link.click();
        }
    });
}

if (upscaleButton) {
    upscaleButton.addEventListener('click', async () => {
        if (!outputImage.src || outputImage.classList.contains('hidden')) return;

        const apiKey = process.env.API_KEY;
        if (!apiKey) {
            await openApiKeyDialog();
            return;
        }

        const aspectRatio = (document.querySelector('input[name="aspect-ratio"]:checked') as HTMLInputElement)?.value || '1:1';
        
        startLoadingAnimation();
        showStatusMessage('Upscaling to 4K...');

        try {
            let upscaledImage = await upscaleImage(outputImage.src, apiKey, aspectRatio);
            
            // Apply Watermark
            upscaledImage = await applyWatermark(upscaledImage);
            
            if(outputImage) {
                outputImage.src = upscaledImage;
                outputImage.classList.remove('hidden');
            }
            if(imageActionsContainer) imageActionsContainer.classList.remove('hidden');

            await saveToHistory('Upscaled 4K Image', upscaledImage);
        } catch (error: any) {
             console.error(error);
             showStatusError('Upscale failed: ' + error.message);
        } finally {
            stopLoadingAnimation();
        }
    });
}

if (remixButton) {
    remixButton.addEventListener('click', async () => {
        if (!outputImage.src || outputImage.classList.contains('hidden')) return;
        
        const apiKey = process.env.API_KEY;
        if (!apiKey) {
             await openApiKeyDialog();
             return;
        }

        const currentPrompt = promptEl.value || "An artistic image";
        const negativePrompt = negativePromptInput.value.trim();
        const aspectRatio = (document.querySelector('input[name="aspect-ratio"]:checked') as HTMLInputElement)?.value || '1:1';
        const imageSize = (document.querySelector('input[name="image-size"]:checked') as HTMLInputElement)?.value as ImageSize || '1K';

        startLoadingAnimation();
        showStatusMessage('Dreaming up a remix...');

        try {
            // 1. Generate new prompt
            const newPrompt = await generateRemixPrompt(currentPrompt, apiKey);
            if(promptEl) promptEl.value = newPrompt; // Update UI
            
            showStatusMessage('Rendering remix...');

            // 2. Generate new image based on old image + new prompt
            let finalRemixPrompt = newPrompt;
            if(negativePrompt) {
                 finalRemixPrompt += ` . Ensure the image does not contain: ${negativePrompt}.`;
            }

            let remixedImage = await remixImage(outputImage.src, finalRemixPrompt, apiKey, aspectRatio, imageSize);
            
            // Apply Watermark
            remixedImage = await applyWatermark(remixedImage);
            
            if(outputImage) {
                outputImage.src = remixedImage;
                outputImage.classList.remove('hidden');
            }
            if(imageActionsContainer) imageActionsContainer.classList.remove('hidden');
            
            await saveToHistory(newPrompt, remixedImage);

        } catch (error: any) {
            console.error(error);
            showStatusError('Remix failed: ' + error.message);
        } finally {
            stopLoadingAnimation();
        }
    });
}

// Initial Load
loadFromHistory();