import { useEffect, useState } from "react";

import { getToken } from "@/api/client";
import { API_BASE } from "@/lib/constants";

export function useAuthenticatedFileUrl(filePath?: string): string | undefined {
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
    const url = `${API_BASE}/api/files?path=${encodeURIComponent(filePath)}`;

    fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
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
  }, [filePath]);

  return blobUrl;
}

interface AuthenticatedFileImageProps {
  filePath?: string;
  alt: string;
  className?: string;
}

export function AuthenticatedFileImage({
  filePath,
  alt,
  className,
}: AuthenticatedFileImageProps) {
  const src = useAuthenticatedFileUrl(filePath);

  if (!src) return null;

  return <img src={src} alt={alt} className={className} draggable={false} />;
}
