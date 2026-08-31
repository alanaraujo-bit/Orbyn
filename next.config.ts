import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // better-sqlite3 is a native module and must stay outside the bundler.
  serverExternalPackages: ['better-sqlite3'],

  experimental: {
    // Lets a navigation or Server Action survive the phone dropping to no bars:
    // instead of throwing, Next holds the request and retries when the
    // connection returns, and `useOffline()` tells the UI to say so.
    useOffline: true,
  },

  async headers() {
    return [
      {
        // The worker must never be served from cache, or a phone can stay
        // pinned to an old one indefinitely and never pick up a fix.
        source: '/sw.js',
        headers: [
          { key: 'Content-Type', value: 'application/javascript; charset=utf-8' },
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
        ],
      },
    ];
  },
};

export default nextConfig;
