import React, { useState, useEffect } from "react";
import { getVersion } from "@tauri-apps/api/app";

import ModelSelector from "../model-selector";
import UpdateChecker from "../update-checker";

const Footer: React.FC = () => {
  const [version, setVersion] = useState("");

  useEffect(() => {
    const fetchVersion = async () => {
      try {
        const appVersion = await getVersion();
        setVersion(appVersion);
      } catch (error) {
        console.error("Failed to get app version:", error);
        setVersion("0.1.2");
      }
    };

    fetchVersion();
  }, []);

  return (
    <div className="w-full border-t border-hairline bg-canvas/60 backdrop-blur-xl pt-2.5">
      <div className="flex justify-between items-center text-[11px] px-4 pb-2.5 text-text-muted">
        <div className="flex items-center gap-4">
          <ModelSelector />
        </div>

        {/* Update Status */}
        <div className="flex items-center gap-1.5">
          <UpdateChecker />
          <span className="text-text-faint">•</span>
          {/* eslint-disable-next-line i18next/no-literal-string */}
          <span className="font-mono tabular-nums text-text-faint">
            v{version}
          </span>
        </div>
      </div>
    </div>
  );
};

export default Footer;
