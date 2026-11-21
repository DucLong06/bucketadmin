import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { loadLang } from "./i18n";
import { loadMode } from "./theme";

// The saved language and theme are read first, so the first paint is already in them
// (until then the window shows the theme's page colour: apply_theme in lib.rs).
Promise.all([loadLang(), loadMode()]).then(() =>
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  ),
);
