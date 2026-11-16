export type ModelFile = { path: string; bytes: number } & ({ sha256: string } | { gitSha1: string });
export type ModelPrecision = "q8" | "fp16" | "fp32";
type Download = { repo: string; revision: string; dtype: ModelPrecision; files: readonly ModelFile[] };

const DOWNLOADS = {
  "moonshine-base": { repo: "onnx-community/moonshine-base-ONNX", revision: "b1e9b6aae3c3c7298f10c3798393fdf38e8fbbad", dtype: "q8", files: [
    { path: "config.json", bytes: 922, gitSha1: "1967bf9b1c79c1fa70166a300e3882136593e921" },
    { path: "generation_config.json", bytes: 147, gitSha1: "b45f5d83177964a069f943e80225213bd724200f" },
    { path: "preprocessor_config.json", bytes: 128, gitSha1: "e519add8190c4ef53802d1d593b7973c12ae68c9" },
    { path: "tokenizer.json", bytes: 3761754, gitSha1: "3e2e6918436f479b267467608eccc4ade30c251c" },
    { path: "tokenizer_config.json", bytes: 135735, gitSha1: "a712a75cf20ba1c6e6f1761f2b612c7ecc44ffa0" },
    { path: "onnx/encoder_model_quantized.onnx", bytes: 20513063, sha256: "1dd9ab0a7f987113d30affcba5a068d11c8f90fa0223caa3e491ade431ad9751" },
    { path: "onnx/decoder_model_merged_quantized.onnx", bytes: 42498870, sha256: "cc9f3cd6698a369c6008b41aa60aa3fb3322e7f03c9bdf19d8e6b7200afca4f3" },
  ] },
  "whisper-base": { repo: "onnx-community/whisper-base", revision: "27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c", dtype: "q8", files: [
    { path: "config.json", bytes: 2243, gitSha1: "ce7faf5d5e56e82d4800e55f524582a525639ff7" },
    { path: "generation_config.json", bytes: 3832, gitSha1: "a57cdbf036979f80bb7ff092a0fee6256a81d329" },
    { path: "preprocessor_config.json", bytes: 339, gitSha1: "91876762a536a746d268353c5cba57286e76b058" },
    { path: "tokenizer.json", bytes: 2480466, gitSha1: "1e95340ff836fad1b5932e800fb7b8c5e6d78a74" },
    { path: "tokenizer_config.json", bytes: 282682, gitSha1: "25be523be5ac50a7671a77f55acba082459d6314" },
    { path: "onnx/encoder_model_quantized.onnx", bytes: 23201314, sha256: "5862993336bf33acd23736071aae2b32261d3b1b2f37780194460d4ef974dd46" },
    { path: "onnx/decoder_model_merged_quantized.onnx", bytes: 53693315, sha256: "fa3ef9902734ce5ae6f9ef2bdb2ba9a6c4b5785b09f4f420ce036573dc9d090b" },
  ] },
  "whisper-small": { repo: "onnx-community/whisper-small", revision: "36050c46d777d46dc4b5f43f6d90574fc38f8732", dtype: "q8", files: [
    { path: "config.json", bytes: 2227, gitSha1: "b0447377b1ade057f991a6a0870d2a91de762f7f" },
    { path: "generation_config.json", bytes: 3893, gitSha1: "703dc78ee83e87fca3ace72170253cdfe4cd2d13" },
    { path: "preprocessor_config.json", bytes: 339, gitSha1: "91876762a536a746d268353c5cba57286e76b058" },
    { path: "tokenizer.json", bytes: 2480466, gitSha1: "1e95340ff836fad1b5932e800fb7b8c5e6d78a74" },
    { path: "tokenizer_config.json", bytes: 282683, gitSha1: "d13b786c04765fb1a06492b53587752cd67665ea" },
    { path: "onnx/encoder_model_quantized.onnx", bytes: 92326160, sha256: "a43a83f3c5361cd591cfa7c36f14b43cf7cb22f47a415cc14a8d557be800fa92" },
    { path: "onnx/decoder_model_merged_quantized.onnx", bytes: 156750845, sha256: "ec07c3cbb64172c39791e26ee870a65ac22b458c36722bfe2776b3dbf741e0c9" },
  ] },
  "distil-whisper": { repo: "onnx-community/distil-small.en", revision: "69be759f982d1d4c5b8a987d4140752742619bd0", dtype: "q8", files: [
    { path: "config.json", bytes: 2209, gitSha1: "68060fd9810ca6609b3bd4230b1721b496d8d404" },
    { path: "generation_config.json", bytes: 1913, gitSha1: "54b3b79ccd03161013e15c9d9bd34e74302ffab5" },
    { path: "preprocessor_config.json", bytes: 339, gitSha1: "91876762a536a746d268353c5cba57286e76b058" },
    { path: "tokenizer.json", bytes: 2405466, gitSha1: "d7cd7ef030d38ff11df010adc96a29e3a0222151" },
    { path: "tokenizer_config.json", bytes: 282499, gitSha1: "f9d4873763aaa804a77c9d4bd7c9cc6b6f4225c4" },
    { path: "onnx/encoder_model_quantized.onnx", bytes: 92326170, sha256: "dae677b93ca77f911d858238e277026fa8f95a94cb899ea443ec78ee62726edf" },
    { path: "onnx/decoder_model_merged_quantized.onnx", bytes: 79741921, sha256: "fdeac2c9dd3a468c5f3eb875b21f90f4a291e94599f7db66ceba573bfaf0ec20" },
  ] },
} satisfies Record<string, Download>;

export type LocalModelId = keyof typeof DOWNLOADS;
export type LocalSpeechModel = Download & { id: LocalModelId; name: string; languages: string; speed: string };

const DETAILS: Record<LocalModelId, Pick<LocalSpeechModel, "name" | "languages" | "speed">> = {
  "moonshine-base": { name: "Moonshine Base", languages: "English", speed: "Very fast" },
  "whisper-base": { name: "Whisper Base", languages: "Many languages, including German", speed: "Fast" },
  "whisper-small": { name: "Whisper Small", languages: "Many languages, including German", speed: "Slower, best quality" },
  "distil-whisper": { name: "Distil-Whisper", languages: "English", speed: "Fast" },
};

export const LOCAL_SPEECH_MODELS: readonly LocalSpeechModel[] = (Object.keys(DOWNLOADS) as LocalModelId[]).map(id => ({ id, ...DOWNLOADS[id], ...DETAILS[id] }));
export const localModel = (id: string) => LOCAL_SPEECH_MODELS.find(model => model.id === id);
export const modelBytes = (model: Pick<Download, "files">) => model.files.reduce((total, file) => total + file.bytes, 0);
