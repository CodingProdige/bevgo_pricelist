/** @type {import('next').NextConfig} */
const nextConfig = {
    images: {
      domains: ["firebasestorage.googleapis.com"], // Allow Firebase Storage images
      unoptimized: true,
    },
    reactStrictMode: true,
  };
export default nextConfig;
