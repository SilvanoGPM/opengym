import * as anthropic from './anthropic.js'
import * as openai from './openai.js'
import * as gemini from './gemini.js'

// The only place the three names are enumerated on the client. The server has its own table of
// endpoints and auth headers — deliberately, since it must not need to know anything else.
export const PROVIDERS = { anthropic, openai, gemini }

export const PROVIDER_IDS = Object.keys(PROVIDERS)

export const providerOf = id => PROVIDERS[id] || null
