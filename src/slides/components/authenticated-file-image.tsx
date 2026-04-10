import { useEffect, useState } from "react";

import { getToken } from "@/api/client";
import { buildFileUrl } from "@/api/files";

/**
 * @param filePath - path to the file
 * @param version - optional cache-buster; change this to force re-fetch when file content changes
 */
export function useAuthenticatedFileUrl(filePath?: string, version?: string | number): string | undefined {
  const [blobUrl, setBlobUrl] = useState<string | undefined>(undefined);

  useEffect(() => {
    let revoked = false;
    let objectUrl: string | undefined;

    if (!filePath) {
      setBlobUrl(undefined);
      return;
    }

    setBlobUrl(undefined);

    if (/^https?:\/\//i.test(filePath)) {
      setBlobUrl(filePath);
      return;
    }

    const token = getToken();
    const url = buildFileUrl(filePath);

    fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      cache: "no-store",
    })
      .then((resp) => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.blob();
      })
      .then((blob) => {
        if (revoked) return;
        objectUrl = URL.createObjectURL(blob);
        setBlobUrl(objectUrl);
      })
      .catch(() => {
        if (!revoked) setBlobUrl(undefined);
      });

    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [filePath, version]);

  return blobUrl;
}

interface AuthenticatedFileImageProps {
  filePath?: string;
  alt: string;
  className?: string;
  /** Change to force re-fetch when file content changes at the same path */
  version?: string | number;
}

export function AuthenticatedFileImage({
  filePath,
  alt,
  className,
  version,
}: AuthenticatedFileImageProps) {
  const src = useAuthenticatedFileUrl(filePath, version);

  if (!src) return null;

  return <img src={src} alt={alt} className={className} draggable={false} />;
}
