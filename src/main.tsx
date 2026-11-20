import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { loadLang } from "./i18n";

// The saved language is read first, so the first paint is already in it.
loadLang().then(() =>
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  ),
);
