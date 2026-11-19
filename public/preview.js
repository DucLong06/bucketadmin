// The only document of the app that loads anything from outside the app: one image, audio,
// video or PDF of the object being previewed, straight from the RGW endpoint (the URL is a
// short-lived presigned GET). The main window embeds this page in an iframe and is itself
// forbidden to load remote resources (see the CSP meta tag in index.html).
//
// Before the element is created, this document narrows its own policy to the single origin
// of that URL, so nothing else can be fetched from here either.
(function () {
  var params = new URLSearchParams(location.hash.slice(1));
  var kind = params.get("kind");
  var url = params.get("url") || "";
  var name = params.get("name") || "";
  var tags = { image: "img", audio: "audio", video: "video", pdf: "iframe" };
  var origin = null;
  try {
    var parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") origin = parsed.origin;
  } catch (e) {
    origin = null;
  }
  document.body.style.margin = "0";
  document.body.style.background = "#121212";
  if (!origin || !tags[kind]) {
    document.body.textContent = "Không xem trước được.";
    document.body.style.color = "#fff";
    return;
  }

  var policy = document.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content = "default-src 'none'; img-src " + origin + "; media-src " + origin + "; frame-src " + origin;
  document.head.appendChild(policy);

  var el = document.createElement(tags[kind]);
  if (kind === "image") {
    el.alt = name;
    el.style.cssText = "display:block;max-width:100%";
  } else if (kind === "pdf") {
    el.title = name;
    el.style.cssText = "display:block;width:100%;height:100vh;border:0;background:#fff";
  } else {
    el.controls = true;
    el.setAttribute("aria-label", name);
    el.style.cssText = kind === "audio" ? "display:block;width:100%" : "display:block;max-width:100%;max-height:100vh";
  }
  el.src = url;
  document.body.appendChild(el);

  // Zoom for images: the embedding page posts { zoom: <percent of the natural size> }, 0 = fit.
  window.addEventListener("message", function (event) {
    if (event.source !== window.parent || kind !== "image") return;
    var zoom = event.data && event.data.zoom;
    if (typeof zoom !== "number") return;
    el.style.maxWidth = zoom ? "none" : "100%";
    el.style.width = zoom ? (el.naturalWidth * zoom) / 100 + "px" : "";
  });
})();
