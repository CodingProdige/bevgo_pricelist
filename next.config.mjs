/** @type {import('next').NextConfig} */
const nextConfig = {
    images: {
      remotePatterns: [
        {
          protocol: "https",
          hostname: "firebasestorage.googleapis.com"
        }
      ],
      unoptimized: true,
    },
    reactStrictMode: true,
  };
export default nextConfig;
