import React from "react";
import wordmarkSrc from "@/assets/Ghostly-wordmark.svg";

const GhostlyLogo = ({
  width,
  className,
}: {
  width?: number;
  height?: number;
  className?: string;
}) => {
  return (
    <img
      src={wordmarkSrc}
      width={width || 130}
      className={className}
      alt="Ghostly"
    />
  );
};

export default GhostlyLogo;
