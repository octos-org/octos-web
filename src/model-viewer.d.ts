import type { ModelViewerElement } from "@google/model-viewer";
import type { DetailedHTMLProps, HTMLAttributes } from "react";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "model-viewer": DetailedHTMLProps<
        HTMLAttributes<ModelViewerElement>,
        ModelViewerElement
      > & {
        src?: string;
        alt?: string;
        loading?: "auto" | "lazy" | "eager";
        autoplay?: boolean;
        exposure?: string;
        "auto-rotate"?: boolean;
        "camera-orbit"?: string;
        "field-of-view"?: string;
        "interaction-prompt"?: "auto" | "none";
        "rotation-per-second"?: string;
        "shadow-intensity"?: string;
      };
    }
  }
}
