/*
 * Runtime configuration.
 *
 * BACKEND_URL: the URL of the Node.js server (Render / Railway / Fly.io), without a
 * trailing slash, e.g. "https://shopping-list-server.onrender.com".
 * Leave it empty to run the app in local-only mode (no accounts, no sharing).
 *
 * When the app is opened from localhost it talks to a local server on port 3000.
 */
(function () {
  var isLocal = ["localhost", "127.0.0.1"].indexOf(location.hostname) !== -1;

  window.APP_CONFIG = {
    BACKEND_URL: isLocal ? "http://localhost:3000" : "",
  };
})();
