/*
 * FridgeVision — "AI Fridge Vision": the user photographs their fridge (camera)
 * or picks a photo (gallery), and the image is prepared for the Gemini vision
 * model to detect which groceries are missing.
 *
 * The backend has no vision endpoint yet, so analyzeFridgeImage() is a stub: it
 * does all the client-side work (validate, downscale, JPEG-encode, base64) and
 * returns the request body in Gemini's `inlineData` shape, ready to POST once
 * VISION_ENDPOINT exists on the server.
 */
(function (root) {
  "use strict";

  const MAX_SIDE = 1024; // Gemini tiles images at ~768px; more only costs upload time
  const JPEG_QUALITY = 0.82;
  const MAX_INPUT_BYTES = 25 * 1024 * 1024;
  const VISION_ENDPOINT = null; // e.g. "/api/ai/vision" once the server supports it

  const PROMPT =
    "זו תמונה של המקרר/המזווה שלי. זהה אילו מצרכים בסיסיים חסרים או כמעט נגמרו, " +
    "והחזר רשימת קניות מסודרת לפי מחלקות בסופר.";

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

  /*
   * Stub: prepares `file` for the Gemini vision model.
   * options: { listItems: string[] } — what's already on the list, so it isn't suggested again.
   * Resolves { ready, image, payload } where payload is the future request body.
   */
  async function analyzeFridgeImage(file, options = {}) {
    const image = await prepareImage(file);
    const payload = {
      message: PROMPT,
      listItems: options.listItems || [],
      image: { inlineData: { mimeType: image.mimeType, data: image.base64 } },
    };
    // TODO(server): POST payload to VISION_ENDPOINT with the account token, and hand the
    // returned { reply, sections } to the AI chat exactly like /api/ai/chat answers.
    return { ready: !!VISION_ENDPOINT, endpoint: VISION_ENDPOINT, image, payload };
  }

  root.FridgeVision = { prepareImage, analyzeFridgeImage };
  root.analyzeFridgeImage = analyzeFridgeImage;
})(window);
