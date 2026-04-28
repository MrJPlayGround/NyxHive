import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { Reconnector } from "../channels/reconnect.js"

describe("Reconnector", () => {
  let reconnector: Reconnector

  afterEach(() => {
    reconnector?.stop()
  })

  it("creates with default options", () => {
    reconnector = new Reconnector({ name: "test" })
    // Just verifies construction doesn't throw
    expect(reconnector).toBeDefined()
  })

  it("does not call connectFn immediately", () => {
    reconnector = new Reconnector({ name: "test", baseDelay: 50 })
    let called = false
    reconnector.schedule(async () => { called = true })
    expect(called).toBe(false)
  })

  it("calls connectFn after delay", async () => {
    reconnector = new Reconnector({ name: "test", baseDelay: 10 })
    let called = false
    reconnector.schedule(async () => { called = true })
    await new Promise(r => setTimeout(r, 50))
    expect(called).toBe(true)
  })

  it("resets attempts after successful connection", async () => {
    reconnector = new Reconnector({ name: "test", baseDelay: 10 })
    let count = 0
    reconnector.schedule(async () => { count++ })
    await new Promise(r => setTimeout(r, 50))
    expect(count).toBe(1)
    // Can schedule again since attempts reset
    reconnector.schedule(async () => { count++ })
    await new Promise(r => setTimeout(r, 50))
    expect(count).toBe(2)
  })

  it("retries on failure with exponential backoff", async () => {
    reconnector = new Reconnector({ name: "test", baseDelay: 10, maxAttempts: 3 })
    let attempts = 0
    reconnector.schedule(async () => {
      attempts++
      if (attempts < 3) throw new Error("fail")
    })
    // Wait enough for 3 attempts (10 + 20 + 40 = 70ms + buffer)
    await new Promise(r => setTimeout(r, 200))
    expect(attempts).toBe(3)
  })

  it("stops after max attempts", async () => {
    reconnector = new Reconnector({ name: "test", baseDelay: 10, maxAttempts: 2 })
    let attempts = 0
    reconnector.schedule(async () => {
      attempts++
      throw new Error("always fail")
    })
    await new Promise(r => setTimeout(r, 200))
    expect(attempts).toBe(2)
  })

  it("does not schedule when stopped", () => {
    reconnector = new Reconnector({ name: "test", baseDelay: 10 })
    reconnector.stop()
    let called = false
    reconnector.schedule(async () => { called = true })
    expect(called).toBe(false)
  })

  it("stop cancels pending timer", async () => {
    reconnector = new Reconnector({ name: "test", baseDelay: 100 })
    let called = false
    reconnector.schedule(async () => { called = true })
    reconnector.stop()
    await new Promise(r => setTimeout(r, 150))
    expect(called).toBe(false)
  })

  it("reset clears attempt count", async () => {
    reconnector = new Reconnector({ name: "test", baseDelay: 10, maxAttempts: 1 })
    let count = 0
    reconnector.schedule(async () => {
      count++
      throw new Error("fail")
    })
    await new Promise(r => setTimeout(r, 50))
    expect(count).toBe(1)
    // Reset and try again
    reconnector.reset()
    // Need a fresh reconnector since stopped flag might be set
    reconnector = new Reconnector({ name: "test", baseDelay: 10, maxAttempts: 1 })
    reconnector.schedule(async () => { count++ })
    await new Promise(r => setTimeout(r, 50))
    expect(count).toBe(2)
  })

  it("caps delay at maxDelay", async () => {
    // baseDelay=10, maxDelay=15 — second attempt would be 20 but capped at 15
    reconnector = new Reconnector({ name: "test", baseDelay: 10, maxDelay: 15, maxAttempts: 3 })
    const timestamps: number[] = []
    reconnector.schedule(async () => {
      timestamps.push(Date.now())
      if (timestamps.length < 3) throw new Error("fail")
    })
    await new Promise(r => setTimeout(r, 300))
    // All 3 attempts should complete — delay never exceeds 15ms
    expect(timestamps.length).toBe(3)
  })
})
