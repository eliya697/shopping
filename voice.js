/*
 * VoiceInput — thin wrapper over the Web Speech API (SpeechRecognition).
 * Chrome/Edge/Android and Safari 14.5+ support it (prefixed); Firefox doesn't,
 * in which case `VoiceInput.supported` is false and the mic button stays hidden.
 */
(function (root) {
  "use strict";

  const Recognition = root.SpeechRecognition || root.webkitSpeechRecognition;

  const ERROR_TEXT = {
    "not-allowed": "אין הרשאה למיקרופון. אפשרו גישה בהגדרות הדפדפן.",
    "service-not-allowed": "זיהוי דיבור אינו זמין בדפדפן הזה.",
    "audio-capture": "לא נמצא מיקרופון.",
    "network": "זיהוי דיבור דורש חיבור לאינטרנט.",
    "no-speech": "לא שמעתי כלום, נסו שוב.",
    "language-not-supported": "זיהוי דיבור בעברית אינו נתמך בדפדפן הזה.",
  };

  class VoiceInput {
    constructor({ lang = "he-IL", onStart, onInterim, onResult, onError, onEnd } = {}) {
      this.handlers = { onStart, onInterim, onResult, onError, onEnd };
      this.lang = lang;
      this.recognition = null;
      this.listening = false;
    }

    static get supported() {
      return !!Recognition;
    }

    start() {
      if (!Recognition || this.listening) return;
      const rec = new Recognition();
      rec.lang = this.lang;
      rec.interimResults = true;
      rec.continuous = false; // stop after a pause: one sentence = one batch of items
      rec.maxAlternatives = 1;

      let finalText = "";
      rec.onstart = () => {
        this.listening = true;
        this.handlers.onStart && this.handlers.onStart();
      };
      rec.onresult = (event) => {
        let interim = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const res = event.results[i];
          if (res.isFinal) finalText += res[0].transcript + " ";
          else interim += res[0].transcript;
        }
        this.handlers.onInterim && this.handlers.onInterim((finalText + interim).trim());
      };
      rec.onerror = (event) => {
        if (event.error === "aborted") return;
        this.handlers.onError && this.handlers.onError(ERROR_TEXT[event.error] || "זיהוי הדיבור נכשל, נסו שוב.");
      };
      rec.onend = () => {
        this.listening = false;
        this.recognition = null;
        const text = finalText.trim();
        if (text && this.handlers.onResult) this.handlers.onResult(text);
        this.handlers.onEnd && this.handlers.onEnd();
      };

      this.recognition = rec;
      try {
        rec.start();
      } catch (e) {
        this.recognition = null;
        this.handlers.onError && this.handlers.onError("לא ניתן להפעיל את המיקרופון כרגע.");
      }
    }

    /* Stop listening but still deliver what was heard so far. */
    stop() {
      if (this.recognition) this.recognition.stop();
    }

    /* Stop and throw away the result. */
    cancel() {
      if (!this.recognition) return;
      const { onResult } = this.handlers;
      this.handlers.onResult = null;
      this.recognition.onend = () => {
        this.listening = false;
        this.recognition = null;
        this.handlers.onResult = onResult;
        this.handlers.onEnd && this.handlers.onEnd();
      };
      this.recognition.abort();
    }
  }

  root.VoiceInput = VoiceInput;
})(window);
