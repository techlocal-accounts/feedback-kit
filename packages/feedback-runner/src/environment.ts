const runtimeKeys = [
  "PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "TERM", "CI",
  "PNPM_HOME", "COREPACK_HOME", "DEVELOPER_DIR", "SystemRoot", "WINDIR",
] as const;

/** Do not inherit provider, queue, Git, shell-startup, or package credentials. */
export function runtimeEnvironment(): NodeJS.ProcessEnv {
  return { NODE_ENV: process.env.NODE_ENV ?? "development", OPENSSL_CONF: "/dev/null",
    ...Object.fromEntries(runtimeKeys.flatMap(key => process.env[key] ? [[key, process.env[key]]] : [])) };
}

export function validationEnvironment(extra: Record<string, string>): NodeJS.ProcessEnv {
  for (const [key, value] of Object.entries(extra)) {
    const publicKey = /^(?:NEXT_PUBLIC_|VITE_|EXPO_PUBLIC_|PUBLIC_)/.test(key);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" ||
        /TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE|PRIVATE_KEY/i.test(key) ||
        (!publicKey && /API_KEY|AUTH|DATABASE|SERVICE_ROLE/i.test(key)) ||
        /^(?:NODE_OPTIONS|BASH_ENV|ENV|ZDOTDIR|OPENSSL_CONF|OPENSSL_MODULES|GIT_|CODEX_|NPM_CONFIG_|npm_config_)/.test(key)) {
      throw new Error(`Unsafe validation environment key: ${key}`);
    }
  }
  return { ...runtimeEnvironment(), ...extra, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0" };
}
