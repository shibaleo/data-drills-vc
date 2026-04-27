/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CLERK_PUBLISHABLE_KEY: string;
  readonly VITE_BASE_URL: string;
  readonly VITE_GOOGLE_CLIENT_ID: string;
  readonly VITE_GOOGLE_API_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
