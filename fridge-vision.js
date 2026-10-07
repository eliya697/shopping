/*
 * FridgeVision — "AI Fridge Vision": the user photographs their fridge (camera)
 * or picks a photo (gallery). This module prepares the photo (validate, downscale,
 * JPEG-encode, base64); AIChat.sendPhoto() asks the AI Chef about it, streamed like any
 * other question, with the missing groceries as a one-tap "add to list" card.
 */
(function (root) {
  "use strict";

  const MAX_SIDE = 1024; // Gemini tiles images at ~768px; more only costs upload time
  const JPEG_QUALITY = 0.82;
  const MAX_INPUT_BYTES = 25 * 1024 * 1024;

  // Shown as the user's message in the chat, and sent to the model with the photo.
  const QUESTION = "📸 מה אפשר לבשל ממה שיש לי, ומה חסר?";

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("unreadable image")); };
      img.src = url;
    });
  }

  /* Downscale + re-encode as JPEG. Resolves { dataUrl, base64, mimeType, width, height, bytes }. */
  async function prepareImage(file) {
    if (!file || !/^image\//.test(file.type || "")) throw new Error("not an image");
    if (file.size > MAX_INPUT_BYTES) throw new Error("image too large");
    const img = await loadImage(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const width = Math.round(img.naturalWidth * scale);
    const height = Math.round(img.naturalHeight * scale);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").drawImage(img, 0, 0, width, height);
    const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    return { dataUrl, base64, mimeType: "image/jpeg", width, height, bytes: Math.round(base64.length * 0.75) };
  }

  root.FridgeVision = { prepareImage, QUESTION };
})(window);
