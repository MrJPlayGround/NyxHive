import { describe, it, expect } from "bun:test"
import { sanitizeEnv, CredentialVault } from "../security/vault.js"

describe("sanitizeEnv", () => {
  it("keeps safe vars", () => {
    const result = sanitizeEnv({ PATH: "/usr/bin", HOME: "/home/user", SHELL: "/bin/zsh" })
    expect(result.PATH).toBe("/usr/bin")
    expect(result.HOME).toBe("/home/user")
    expect(result.SHELL).toBe("/bin/zsh")
  })

  it("strips API key vars", () => {
    const result = sanitizeEnv({ OPENAI_API_KEY: "sk-123", ANTHROPIC_API_KEY: "ant-456" })
    expect(result.OPENAI_API_KEY).toBeUndefined()
    expect(result.ANTHROPIC_API_KEY).toBeUndefined()
  })

  it("strips secret vars", () => {
    const result = sanitizeEnv({ CLIENT_SECRET: "abc", JWT_SECRET: "xyz" })
    expect(result.CLIENT_SECRET).toBeUndefined()
    expect(result.JWT_SECRET).toBeUndefined()
  })

  it("strips password vars", () => {
    const result = sanitizeEnv({ DB_PASSWORD: "pass", ADMIN_PASSWD: "secret" })
    expect(result.DB_PASSWORD).toBeUndefined()
    expect(result.ADMIN_PASSWD).toBeUndefined()
  })

  it("strips token vars", () => {
    const result = sanitizeEnv({ GITHUB_TOKEN: "ghp_123", SLACK_TOKEN: "xoxb-456" })
    expect(result.GITHUB_TOKEN).toBeUndefined()
    expect(result.SLACK_TOKEN).toBeUndefined()
  })

  it("strips credential vars", () => {
    const result = sanitizeEnv({ GCP_CREDENTIAL: "json-blob" })
    expect(result.GCP_CREDENTIAL).toBeUndefined()
  })

  it("strips private key vars", () => {
    const result = sanitizeEnv({ SSH_PRIVATE_KEY: "key-data", PRIVATE_KEY: "more-keys" })
    expect(result.SSH_PRIVATE_KEY).toBeUndefined()
    expect(result.PRIVATE_KEY).toBeUndefined()
  })

  it("strips auth vars", () => {
    const result = sanitizeEnv({ AUTH_HEADER: "Bearer xyz", BASIC_AUTH: "user:pass" })
    expect(result.AUTH_HEADER).toBeUndefined()
    expect(result.BASIC_AUTH).toBeUndefined()
  })

  it("keeps non-sensitive vars", () => {
    const result = sanitizeEnv({ MY_APP_PORT: "3000", DEBUG: "true", LOG_LEVEL: "info" })
    expect(result.MY_APP_PORT).toBe("3000")
    expect(result.DEBUG).toBe("true")
    expect(result.LOG_LEVEL).toBe("info")
  })

  it("skips undefined values", () => {
    const result = sanitizeEnv({ DEFINED: "yes", UNDEF: undefined })
    expect(result.DEFINED).toBe("yes")
    expect("UNDEF" in result).toBe(false)
  })

  it("safe vars override sensitive patterns", () => {
    // NODE_ENV contains no sensitive patterns, but PATH is safe-listed
    // CLAUDE_CONFIG_DIR is safe-listed even though it doesn't match sensitive
    const result = sanitizeEnv({ PATH: "/usr/bin", NODE_ENV: "production", CLAUDE_CONFIG_DIR: "/tmp" })
    expect(result.PATH).toBe("/usr/bin")
    expect(result.NODE_ENV).toBe("production")
    expect(result.CLAUDE_CONFIG_DIR).toBe("/tmp")
  })

  it("pattern matching is case-insensitive", () => {
    const result = sanitizeEnv({ api_key: "val", Api_Key: "val", API_KEY: "val" })
    expect(Object.keys(result)).toHaveLength(0)
  })
})

describe("CredentialVault", () => {
  it("stores and retrieves secrets", () => {
    const vault = new CredentialVault({ KEY: "value" })
    expect(vault.get("KEY")).toBe("value")
  })

  it("returns undefined for missing keys", () => {
    const vault = new CredentialVault({})
    expect(vault.get("MISSING")).toBeUndefined()
  })

  it("has() checks existence", () => {
    const vault = new CredentialVault({ KEY: "val" })
    expect(vault.has("KEY")).toBe(true)
    expect(vault.has("MISSING")).toBe(false)
  })

  describe("getForAgent", () => {
    it("returns only declared credentials", () => {
      const vault = new CredentialVault({ A: "1", B: "2", C: "3" })
      const result = vault.getForAgent(["A", "C"])
      expect(result).toEqual({ A: "1", C: "3" })
    })

    it("silently skips missing credentials", () => {
      const vault = new CredentialVault({ A: "1" })
      const result = vault.getForAgent(["A", "MISSING"])
      expect(result).toEqual({ A: "1" })
    })

    it("returns empty object when no credentials match", () => {
      const vault = new CredentialVault({ A: "1" })
      const result = vault.getForAgent(["X", "Y"])
      expect(result).toEqual({})
    })

    it("logs access with agent name", () => {
      const vault = new CredentialVault({ KEY: "val" })
      vault.getForAgent(["KEY"], "nyx")
      const log = vault.getAccessLog()
      expect(log).toHaveLength(1)
      expect(log[0].agent).toBe("nyx")
      expect(log[0].credentials).toEqual(["KEY"])
      expect(log[0].timestamp).toBeGreaterThan(0)
    })

    it("uses 'unknown' when no agent name", () => {
      const vault = new CredentialVault({ KEY: "val" })
      vault.getForAgent(["KEY"])
      const log = vault.getAccessLog()
      expect(log[0].agent).toBe("unknown")
    })

    it("does not log when no credentials matched", () => {
      const vault = new CredentialVault({})
      vault.getForAgent(["MISSING"], "agent")
      expect(vault.getAccessLog()).toHaveLength(0)
    })
  })

  describe("access log", () => {
    it("limits to requested entries", () => {
      const vault = new CredentialVault({ A: "1" })
      for (let i = 0; i < 5; i++) vault.getForAgent(["A"], `agent-${i}`)
      const log = vault.getAccessLog(2)
      expect(log).toHaveLength(2)
      expect(log[0].agent).toBe("agent-3")
      expect(log[1].agent).toBe("agent-4")
    })

    it("prunes to 500 entries after exceeding 1000", () => {
      const vault = new CredentialVault({ A: "1" })
      for (let i = 0; i < 1001; i++) vault.getForAgent(["A"], `agent-${i}`)
      const log = vault.getAccessLog(1000)
      expect(log.length).toBeLessThanOrEqual(501) // 500 kept + 1 new
    })
  })
})
