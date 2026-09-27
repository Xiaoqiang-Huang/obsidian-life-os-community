import type { SharedDeviceIdentity } from './shared-device-identity';

/** Inject requestUrl at the UI boundary. Never log bodies or persist login tokens in a Vault. */
export type AccountTransport = (request: {
  url: string; method: 'POST'|'GET'; headers: Record<string, string>; body: string;
}) => Promise<{ status: number; json: unknown }>;

export interface DeviceRegistration {
  sessionId: string; deviceId: string; refreshToken: string; expiresAt: string;
  authorizationMode: 'session-registration-only';
}

/** Staged protocol client: registration is NOT a Pro entitlement and does not modify legacy settings. */
export class AccountDeviceClient {
  private readonly base: string;
  constructor(base: string, private readonly transport: AccountTransport) {
    const url = new URL(base);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      throw new Error('account_server_requires_https');
    this.base = url.origin;
  }
  private async post(path: string, body: unknown, token?: string): Promise<any> {
    const response = await this.transport({url: this.base + path, method: 'POST',
      headers: {'content-type': 'application/json', ...(token ? {authorization: `Bearer ${token}`} : {})},
      body: JSON.stringify(body)});
    const result = response.json as any;
    if (response.status < 200 || response.status >= 300 || result?.ok !== true) {
      // Server messages can contain untrusted input; expose only a bounded error code.
      const code = result?.error?.code;
      throw new Error(typeof code === 'string' && /^[a-z_]{1,80}$/.test(code) ? code : 'account_request_failed');
    }
    return result.data;
  }
  async requestCode(email: string): Promise<void> {
    await this.post('/api/portal/request-code', {email});
  }
  async login(email: string, code: string): Promise<string> {
    const result = await this.post('/api/account/login', {email, code});
    if (typeof result?.loginToken !== 'string' || !result.loginToken) throw new Error('invalid_login_response');
    return result.loginToken;
  }
  async licenses(token:string):Promise<Array<{id:string;sku:string;status:string;expires_at:string|null;used_seats:number;max_activations:number}>> {
    const response=await this.transport({url:this.base+'/api/account/devices',method:'GET',headers:{authorization:`Bearer ${token}`},body:''});
    const json=response.json as any;
    if(response.status!==200||json?.ok!==true||!Array.isArray(json.data?.licenses))throw new Error('account_list_failed');
    return json.data.licenses;
  }
  async register(input: {
    loginToken: string; identity: SharedDeviceIdentity; licenseId: string;
    deviceLabel: string; platform: string; vaultLabel: string;
    legacy?: {token: string; installationId: string};
    reEnroll?: boolean;
    intent?: {operationId:string;refreshToken:string};
  }): Promise<DeviceRegistration> {
    const {identity, loginToken, legacy, intent, ...metadata} = input;
    if(input.reEnroll && legacy)throw new Error('reenrollment_cannot_restore_legacy');
    const hash=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
    const initialRefreshHash=intent?await hash(intent.refreshToken):undefined;
    const scope = {...metadata, ...(legacy ? {legacyToken: legacy.token, installationId: legacy.installationId} : {}),
      ...(intent?{operationId:intent.operationId,initialRefreshHash}: {})};
    const challenge = await this.post('/api/account/challenge', {...scope, publicKeyPem: identity.publicKeyPem}, loginToken);
    // Do not sign arbitrary server text. Bind the challenge to this identity and requested operation.
    let parts: unknown[];
    try { parts = JSON.parse(challenge.message); } catch { throw new Error('invalid_device_challenge'); }
    if (!Array.isArray(parts) || parts.length !== 9 || parts[0] !== 'lifeos-device-proof' || parts[1] !== 1 ||
        parts[2] !== challenge.challengeId || parts[4] !== identity.deviceKeyId ||
        parts[5] !== (legacy ? 'migration' : 'login') || parts[7] !== challenge.expiresAt ||
        !Number.isFinite(Date.parse(challenge.expiresAt)) || Date.parse(challenge.expiresAt) <= Date.now())
      throw new Error('invalid_device_challenge');
    if(intent){
      let activationId=null;
      if(legacy){try{activationId=JSON.parse(atob(legacy.token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))).activationId;}catch{throw new Error('invalid_legacy_registration_intent');}}
      const expected='registration:'+await hash(JSON.stringify([input.licenseId,activationId,!!input.reEnroll,intent.operationId,initialRefreshHash]));
      if(parts[6]!==expected)throw new Error('invalid_device_challenge');
    }else{
    let binding: unknown;
    try { binding = JSON.parse(String(parts[6])); } catch { throw new Error('invalid_device_challenge'); }
    if (!Array.isArray(binding) || binding.length !== (input.reEnroll?3:2) ||
        (input.reEnroll && binding[2]!=='re-enroll') || binding[0] !== input.licenseId ||
        (legacy ? typeof binding[1] !== 'string' || !binding[1] : binding[1] !== null))
      throw new Error('invalid_device_challenge');
    }
    const signature = await identity.signChallenge(challenge.message);
    const result = await this.post(input.reEnroll?'/api/account/re-enroll':'/api/account/open-session', {...scope, challengeId: challenge.challengeId, signature}, loginToken);
    if(intent)result.refreshToken=intent.refreshToken;
    if (result?.authorizationMode !== 'session-registration-only' ||
        !['sessionId', 'deviceId', 'refreshToken', 'expiresAt'].every(key => typeof result[key] === 'string' && result[key]) ||
        !Number.isFinite(Date.parse(result.expiresAt))) throw new Error('invalid_registration_response');
    return result;
  }
}
