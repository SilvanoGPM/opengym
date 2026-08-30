// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { api, webauthnOK } from './api.js'

const originalPublicKeyCredential = window.PublicKeyCredential
const originalCredentials = navigator.credentials

function setCapability(target, property, value) {
  Object.defineProperty(target, property, { configurable: true, value })
}

afterEach(() => {
  setCapability(window, 'PublicKeyCredential', originalPublicKeyCredential)
  setCapability(navigator, 'credentials', originalCredentials)
})

describe('webauthnOK', () => {
  it('accepts WebAuthn when PublicKeyCredential is exposed', () => {
    setCapability(window, 'PublicKeyCredential', class PublicKeyCredential {})
    setCapability(navigator, 'credentials', {})
    expect(webauthnOK()).toBe(true)
  })

  it('does not reject WebAuthn when the generic credentials check is unavailable', () => {
    setCapability(window, 'PublicKeyCredential', class PublicKeyCredential {})
    setCapability(navigator, 'credentials', undefined)
    expect(webauthnOK()).toBe(true)
  })

  it('rejects browsers without the WebAuthn credential type', () => {
    setCapability(window, 'PublicKeyCredential', undefined)
    setCapability(navigator, 'credentials', {})
    expect(webauthnOK()).toBe(false)
  })
})

describe('api', () => {
  const withFetch = (status, body) => {
    const original = globalThis.fetch
    globalThis.fetch = async () => ({ ok: status < 400, status, json: async () => body })
    return () => { globalThis.fetch = original }
  }

  it('carries the server’s error code, not just its prose', async () => {
    // Callers branch on WHICH failure this was — a spending cap is a different thing to say
    // than a bad key. Matching on the message would break the moment it is translated.
    const restore = withFetch(402, { code: 'ai-cap', error: 'cap reached' })
    try {
      await expect(api('/api/ai/chat')).rejects.toMatchObject({
        status: 402, code: 'ai-cap', message: 'cap reached'
      })
    } finally { restore() }
  })

  it('leaves code undefined when the server sent none', async () => {
    const restore = withFetch(401, { error: 'not signed in' })
    try {
      const err = await api('/api/me').catch(e => e)
      expect(err.status).toBe(401)
      expect(err.code).toBeUndefined()
    } finally { restore() }
  })

  it('falls back to the status when the body says nothing', async () => {
    const restore = withFetch(504, {})
    try {
      await expect(api('/api/me')).rejects.toThrow('HTTP 504')
    } finally { restore() }
  })
})
