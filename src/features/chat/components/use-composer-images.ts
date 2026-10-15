import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipc as defaultIpc, ipcForMachine } from "@/lib/ipc";
import { fileName } from "@/features/files/store";
import { dataUrlBytes, imageDimensions } from "@/utils/image-meta";

/** Extensions routed through the path-based image pipeline; anything else a
 *  user picks becomes an @mention instead of an attachment. */
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"];
/** Chip thumbnail plus the metadata shown beside it: pixel dimensions and
 *  file size recovered from the preview data URL (exact base64 math, no
 *  extra stat IPC). Fields appear asynchronously after the preview loads. */
export interface AttachmentPreview {
  url: string;
  name: string;
  width?: number;
  height?: number;
  size?: number;
}

/** Composer image attachments: the attached image paths, their chip
 * thumbnails, and clipboard-paste handling.
 *
 * Thumbnail URLs are data URLs from the backend's readFile — the asset
 * protocol scope denies ~/.ccgui-next (app home holds secrets), so asset://
 * thumbnails of pasted images would be blocked. Same pipeline MessageImages
 * uses.
 *
 * Clipboard images are blobs without a path: persist them via the backend
 * so they flow through the same path-based pipeline every engine consumes
 * (codex -i, kimi path injection, pi/omp @file, claude/grok base64). */
export interface ComposerImages {
  images: string[];
  /** path → { preview-url, display name } for attachment chip thumbnails. */
  previews: Record<string, AttachmentPreview>;
  imageError: string | null;
  removeImage: (path: string) => void;
  clearImages: () => void;
  pasteImages: (files: File[]) => void;
  importImageFiles: (paths: string[], supported: boolean) => void;
  dismissImageError: () => void;
}

export function useComposerImages(machine?: string): ComposerImages {
  const ipc = machine ? ipcForMachine(machine) : defaultIpc;
  const { t } = useTranslation();
  const [images, setImages] = useState<string[]>([]);
  const [previews, setPreviews] = useState<Record<string, AttachmentPreview>>({});
  const [imageError, setImageError] = useState<string | null>(null);
  /** Drop one attachment and its preview. */
  const removeImage = useCallback((path: string) => {
    setImages((prev) => prev.filter((p) => p !== path));
    setPreviews((prev) => {
      if (!(path in prev)) return prev;
      const next = { ...prev };
      delete next[path];
      return next;
    });
  }, []);
  /** Clear all attachments (on submit). */
  const clearImages = useCallback(() => {
    setImages([]);
    setPreviews((prev) => (Object.keys(prev).length > 0 ? {} : prev));
  }, []);
  /** Dismiss the paste-error banner without clearing attachments. */
  const dismissImageError = useCallback(() => setImageError(null), []);
  /** Resolve one attachment's chip thumbnail through readFile (data URL),
   * then fill in size (from the data URL payload) and pixel dimensions (from
   * decoding the image). Unreadable/oversized files simply get no thumbnail —
   * the chip falls back to a plain filename. */
  const loadPreview = useCallback((path: string, name: string) => {
    ipc
      .readFile(path)
      .then(async (content) => {
        if (content.kind !== "image" || !content.dataUrl) return;
        const url = content.dataUrl;
        const dims = (await imageDimensions(url)) ?? undefined;
        setPreviews((prev) => ({
          ...prev,
          [path]: {
            url,
            name,
            width: dims?.width,
            height: dims?.height,
            size: dataUrlBytes(url) ?? undefined,
          },
        }));
      })
      .catch(() => {});
  }, [ipc]);
  const pasteImages = useCallback(
    (files: File[]) => {
      setImageError(null);
      for (const file of files) {
        const ext = file.type.split("/")[1]?.toLowerCase() ?? "png";
        if (!IMAGE_EXTENSIONS.includes(ext)) continue;
        const name = file.name || `pasted-image.${ext}`;
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = typeof reader.result === "string" ? reader.result : "";
          const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
          if (!base64) return;
          ipc
            .savePastedImage(base64, ext)
            .then((path) => {
              setImages((prev) => [...prev, path]);
              loadPreview(path, name);
            })
            .catch((err) => {
              setImageError(t("chat.imagePasteFailed", { message: String(err) }));
            });
        };
        reader.readAsDataURL(file);
      }
    },
    [t, loadPreview, ipc],
  );

  /** Import user-picked image files: copy them into the app sandbox (picked
   * paths live outside it, so the engines' path-based pipeline cannot read
   * them in place), then attach with chip previews. `supported` gates engines
   * without image input. */
  const importImageFiles = useCallback(
    (paths: string[], supported: boolean) => {
      setImageError(null);
      if (!supported) {
        setImageError(t("chat.imagesUnsupported"));
        return;
      }
      ipc
        .importAttachments(paths)
        .then((imported) => {
          setImages((prev) => {
            const seen = new Set(prev);
            const added = imported.filter((p) => !seen.has(p));
            return added.length > 0 ? [...prev, ...added] : prev;
          });
          for (const path of imported) {
            loadPreview(path, fileName(path));
          }
        })
        .catch((err) => {
          setImageError(t("chat.imageImportFailed", { message: String(err) }));
        });
    },
    [t, loadPreview, ipc],
  );
  return {
    images,
    previews,
    imageError,
    removeImage,
    clearImages,
    pasteImages,
    importImageFiles,
    dismissImageError,
  };
}
