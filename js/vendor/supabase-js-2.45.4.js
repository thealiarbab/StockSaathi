// supabase-js 2.45.4, served from our own domain (C18). The .umd.js beside
// this file is the package's own dist/umd/supabase.js, byte-identical to the
// npm tarball (sha512-E5p8/zOLaQ3a462MZnmnz03CrduA5ySH9hZyL03Y+QZLIOO4/Gs8Rdy4ZCKDHsN7x0xdanVEWWFN3pJFQr9/hg==).
// It sets self.supabase when loaded as a module; this re-exports it.
import "./supabase-js-2.45.4.umd.js";

const lib = globalThis.supabase;
export const createClient = lib.createClient;
export default lib;
