/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  // The prompt templates and Domain Packs are read from disk at runtime. Trace
  // them into the standalone output so they ship in the Docker image.
  outputFileTracingIncludes: {
    "/api/analyze": ["./prompts/**/*", "./domains/**/*"],
    "/api/chat": ["./prompts/**/*", "./domains/**/*"],
    "/api/eval": ["./prompts/**/*", "./domains/**/*"],
    "/api/logs": ["./domains/**/*"],
    "/settings": ["./prompts/**/*", "./domains/**/*"],
  },
  // The dynamic config/prompt reads make the tracer pull in the whole project;
  // keep the demo (examples/) out of the standalone bundle.
  outputFileTracingExcludes: {
    "*": ["./examples/**/*"],
  },
}

export default nextConfig
