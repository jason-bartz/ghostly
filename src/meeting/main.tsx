import React from "react";
import ReactDOM from "react-dom/client";
import MeetingPanel from "./MeetingPanel";
import "@/App.css";
import "@/i18n";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <MeetingPanel />
  </React.StrictMode>,
);
