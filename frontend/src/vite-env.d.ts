/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_WS_URL?: string;
  /** Client-side upload size pre-check; keep in line with the backend's MAX_UPLOAD_SIZE_MB. */
  readonly VITE_MAX_UPLOAD_MB?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
