import type { Config } from "jest";

const config: Config = {
  transformIgnorePatterns: [],
  moduleNameMapper: {
    "^unicorn-magic/node$": "<rootDir>/node_modules/unicorn-magic/node.js",
  },
  maxWorkers: 1,
  verbose: true,
  testPathIgnorePatterns: ["<rootDir>/node_modules/", "<rootDir>/dist/"],
  collectCoverageFrom: ["src/**/*.ts"],
  restoreMocks: true,
};

export default config;
