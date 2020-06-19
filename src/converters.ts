import {
  VerifiableCredential,
  JWT,
  JwtPresentationPayload,
  JwtCredentialPayload,
  CredentialPayload,
  Credential,
  Verifiable,
  PresentationPayload,
  Presentation
} from './types'
import { decodeJWT } from 'did-jwt'
import { JWT_FORMAT, DEFAULT_JWT_PROOF_TYPE } from './constants'

function asArray(input: any) {
  return Array.isArray(input) ? input : [input]
}

function notEmpty<TValue>(value: TValue | null | undefined): value is TValue {
  return value !== null && value !== undefined
}

function cleanUndefined<T>(input: T): T {
  if (typeof input !== 'object') {
    return input
  }
  const obj = { ...input }
  Object.keys(obj).forEach((key) => obj[key] === undefined && delete obj[key])
  return obj
}

function normalizeJwtCredentialPayload(input: Partial<JwtCredentialPayload>): Credential {
  let result: Partial<CredentialPayload> = { ...input }

  //FIXME: handle case when credentialSubject(s) are not object types
  result.credentialSubject = { ...input.credentialSubject, ...input.vc?.credentialSubject }
  if (input.sub && !input.credentialSubject?.id) {
    result.credentialSubject.id = input.sub
    delete result.sub
  }
  delete result.vc?.credentialSubject

  if (typeof input.issuer === 'undefined' || typeof input.issuer === 'object') {
    result.issuer = cleanUndefined({ id: input.iss, ...input.issuer })
    if (!input.issuer?.id) {
      delete result.iss
    }
  }

  if (!input.id && input.jti) {
    result.id = result.id || result.jti
    delete result.jti
  }

  const types = [...asArray(result.type), ...asArray(result.vc?.type)].filter(notEmpty)
  result.type = [...new Set(types)]
  delete result.vc?.type

  const contextArray: string[] = [
    ...asArray(input.context),
    ...asArray(input['@context']),
    ...asArray(input.vc?.['@context'])
  ].filter(notEmpty)
  result['@context'] = [...new Set(contextArray)]
  delete result.context
  delete result.vc?.['@context']

  if (!input.issuanceDate && (input.iat || input.nbf)) {
    result.issuanceDate = new Date((input.nbf || input.iat) * 1000).toISOString()
    if (input.nbf) {
      delete result.nbf
    } else {
      delete result.iat
    }
  }

  if (!input.expirationDate && input.exp) {
    result.expirationDate = new Date(input.exp * 1000).toISOString()
    delete result.exp
  }

  if (result.vc && Object.keys(result.vc).length == 0) {
    delete result.vc
  }

  //FIXME: interpret `aud` property as `verifier`

  return result as Credential
}

function normalizeJwtCredential(input: JWT): Verifiable<Credential> {
  let decoded
  try {
    decoded = decodeJWT(input)
  } catch (e) {
    const err = new Error('unknown credential format')
    err['cause'] = e
    throw err
  }
  return {
    ...normalizeJwtCredentialPayload(decoded.payload),
    proof: {
      type: DEFAULT_JWT_PROOF_TYPE,
      jwt: input
    }
  }
}

/**
 * Normalizes a credential payload into an unambiguous W3C credential data type
 * In case of conflict, Existing W3C Credential specific properties take precedence,
 * except for arrays and object types which get merged.
 * @param input either a JWT or JWT payload, or a VerifiableCredential
 */
export function normalizeCredential(
  input: Partial<VerifiableCredential> | Partial<JwtCredentialPayload>
): Verifiable<Credential> {
  if (typeof input === 'string') {
    if (JWT_FORMAT.test(input)) {
      return normalizeJwtCredential(input)
    } else {
      let parsed: object
      try {
        parsed = JSON.parse(input)
      } catch (e) {
        const err = new Error('unknown credential format')
        err['cause'] = e
        throw err
      }
      return normalizeCredential(parsed)
    }
  } else if (input.proof?.jwt) {
    //TODO: test that it correctly propagates app specific proof properties
    return { ...normalizeJwtCredential(input.proof.jwt), proof: input.proof }
  } else {
    //TODO: test that it accepts JWT payload, CredentialPayload, VerifiableCredential
    //TODO: test that it correctly propagates proof, if any
    return { proof: {}, ...normalizeJwtCredentialPayload(input) }
  }
}

/**
 * type used to signal a very loose input is accepted
 */
type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T

/**
 * Transforms a W3C Credential payload into a JWT compatible encoding.
 * The method accepts app specific fields and in case of collision, existing JWT properties will take precedence.
 * Also, `nbf`, `exp` and `jti` properties can be explicitly set to `undefined` and they will be kept intact.
 * @param input either a JWT payload or a CredentialPayloadInput
 */
export function transformCredentialInput(
  input: Partial<CredentialPayload> | DeepPartial<JwtCredentialPayload>
): JwtCredentialPayload {
  if (Array.isArray(input.credentialSubject)) throw Error('credentialSubject of type array not supported')

  const result: Partial<JwtCredentialPayload> = { vc: { ...input.vc }, ...input }

  const credentialSubject = { ...input.credentialSubject, ...input.vc?.credentialSubject }
  if (!input.sub) {
    result.sub = input.credentialSubject?.id
    delete credentialSubject.id
  }
  result.vc.credentialSubject = credentialSubject
  delete result.credentialSubject

  const contextEntries = [
    ...asArray(input.context),
    ...asArray(input['@context']),
    ...asArray(input.vc?.['@context'])
  ].filter(notEmpty)
  result.vc['@context'] = [...new Set(contextEntries)]
  delete result.context
  delete result['@context']

  const types = [...asArray(input.type), ...asArray(input.vc?.type)].filter(notEmpty)
  result.vc.type = [...new Set(types)]
  delete result.type

  if (input.id && Object.getOwnPropertyNames(input).indexOf('jti') == -1) {
    result.jti = input.id
    delete result.id
  }

  if (input.issuanceDate && Object.getOwnPropertyNames(input).indexOf('nbf') == -1) {
    const converted = Date.parse(input.issuanceDate)
    if (!isNaN(converted)) {
      result.nbf = converted / 1000
      delete result.issuanceDate
    }
  }

  if (input.expirationDate && Object.getOwnPropertyNames(input).indexOf('exp') == -1) {
    const converted = Date.parse(input.expirationDate)
    if (!isNaN(converted)) {
      result.exp = converted / 1000
      delete result.expirationDate
    }
  }

  if (input.issuer && Object.getOwnPropertyNames(input).indexOf('iss') == -1) {
    if (typeof input.issuer === 'object') {
      result.iss = input.issuer?.id
      delete result.issuer.id
      if (Object.keys(result.issuer).length == 0) {
        delete result.issuer
      }
    } else if (typeof input.issuer === 'string') {
      result.iss = input.iss || '' + input.issuer
      delete result.issuer
    } else {
      //nop
    }
  }

  return result as JwtCredentialPayload
}

function normalizeJwtPresentationPayload(input: Partial<JwtPresentationPayload>): Presentation {
  let result: Partial<PresentationPayload> = { ...input }

  result.verifiableCredential = [...asArray(input.verifiableCredential), ...asArray(input.vp?.verifiableCredential)]
  result.verifiableCredential = result.verifiableCredential.map(normalizeCredential)

  if (input.iss) {
    result.holder = input.holder || input.iss
    delete result.iss
  }

  if (input.aud) {
    result.verifier = [...asArray(input.verifier), ...asArray(input.aud)]
    delete result.aud
  }

  if (input.jti) {
    result.id = input.id || input.jti
    delete result.jti
  }

  result.type = [...asArray(input.type), ...asArray(input.vp.type)]
  result['@context'] = [...asArray(input.context), ...asArray(input['@context']), ...asArray(input.vp['@context'])]
  delete result.context
  //TODO: figure out if the whole vp property should be deleted
  delete result.vp.context
  delete result.vp.type

  //TODO: test parsing Date strings into Date objects
  if (input.iat || input.nbf) {
    result.issuanceDate = input.issuanceDate || new Date(input.nbf || input.iat).toISOString()
    delete result.nbf
    delete result.iat
  }

  if (input.exp) {
    result.expirationDate = input.expirationDate || new Date(input.exp).toISOString()
    delete result.exp
  }

  return result as Presentation
}

function normalizeJwtPresentation(input: JWT): Verifiable<Presentation> {
  return {
    ...normalizeJwtPresentationPayload(decodeJWT(input).payload),
    proof: {
      type: DEFAULT_JWT_PROOF_TYPE,
      jwt: input
    }
  }
}

/**
 * Normalizes a presentation payload into an unambiguous W3C Presentation data type
 * @param input either a JWT or JWT payload, or a VerifiablePresentation
 */
export function normalizePresentation(
  input: Partial<PresentationPayload> | Partial<JwtPresentationPayload>
): Verifiable<Presentation> {
  if (typeof input === 'string') {
    //FIXME: attempt to deserialize as JSON before assuming it is a JWT
    return normalizeJwtPresentation(input)
  } else if (input.proof?.jwt) {
    //TODO: test that it correctly propagates app specific proof properties
    return { ...normalizeJwtPresentation(input.proof.jwt), proof: input.proof }
  } else {
    //TODO: test that it accepts JWT payload, PresentationPayload, VerifiablePresentation
    //TODO: test that it correctly propagates proof, if any
    return { proof: {}, ...normalizeJwtPresentationPayload(input) }
  }
}

export function transformPresentationInput(
  input: Partial<PresentationPayload> | Partial<JwtPresentationPayload>
): JwtPresentationPayload {
  //TODO: test that app specific input.vp properties are preserved
  const result: Partial<JwtPresentationPayload> = { vp: { ...input.vp }, ...input }

  //TODO: check that all context combos are preserved
  result.vp['@context'] = [...asArray(input.context), ...asArray(input['@context']), ...asArray(input.vp['@context'])]
  delete result.context
  delete result['@context']

  //TODO: check that all type combos are preserved
  result.vc.type = [...asArray(input.type), ...asArray(input.vp?.type)]
  delete result.type

  result.vp.verifiableCredential = [
    ...asArray(result.verifiableCredential),
    ...asArray(result.vp?.verifiableCredential)
  ].map((credential: VerifiableCredential) => {
    if (typeof credential === 'object' && credential.proof?.jwt) {
      return credential.proof.jwt
    } else {
      return credential
    }
  })
  delete result.verifiableCredential

  //TODO: check that existing jti is preserved and that id is used if not
  if (input.id) {
    result.jti = input.jti || input.id
    delete result.id
  }

  //TODO: check that issuanceDate is used if present and that nbf is preserved if present
  if (input.issuanceDate) {
    result.nbf = input.nbf || Date.parse(input.issuanceDate) / 1000
    delete result.issuanceDate
  }

  //TODO: check that expiryDate is used if present and that exp is preserved if present
  if (input.expirationDate) {
    result.exp = input.exp || Date.parse(input.expirationDate) / 1000
    delete result.expirationDate
  }

  //TODO: check that iss is preserved, if present
  //TODO: check that issuer is used as string if present
  if (input.holder) {
    result.iss = input.iss || input.holder
    delete result.issuer
  }

  //TODO: check that aud members are preserved, if present
  if (input.verifier) {
    result.aud = [...asArray(input.verifier), ...asArray(input.aud)]
    delete result.verifier
  }

  return result as JwtPresentationPayload
}