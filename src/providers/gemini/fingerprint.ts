// Cloud Code Assist gates on the gemini-cli client fingerprint, so both the login-time control-plane
// calls (onboard.ts) and the inference transport must present this exact Node-client UA pair.
export const GEMINI_CODE_ASSIST_HOST = 'cloudcode-pa.googleapis.com'
export const GEMINI_CLI_USER_AGENT = 'google-api-nodejs-client/9.15.1 (gzip)'
export const GEMINI_GOOG_API_CLIENT = 'gl-node/24.0.0'
