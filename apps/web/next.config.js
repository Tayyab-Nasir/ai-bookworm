/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@bookworm/types", "@bookworm/book-model", "@bookworm/api-client"],
};

export default nextConfig;
