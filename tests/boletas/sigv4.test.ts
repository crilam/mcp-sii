import { firmarSigV4 } from '../../src/boletas/sigv4';

// El test vector canónico de AWS ("get-vanilla" de la SigV4 test suite): con
// estas credenciales, región, servicio y fecha fijas, el header Authorization
// tiene UN valor conocido y publicado por AWS. Si nuestra firma lo reproduce, el
// algoritmo está bien; si no, está mal. Es la única forma honesta de probar una
// firma criptográfica: contra un resultado que no calculamos nosotros.
const CRED_EJEMPLO = {
  accessKeyId: 'AKIDEXAMPLE',
  secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  sessionToken: '',
  expiration: 0,
};

describe('firmarSigV4', () => {
  it('reproduce el test vector oficial de AWS (get-vanilla)', () => {
    const headers = firmarSigV4(
      {
        method: 'GET',
        url: 'https://example.amazonaws.com/',
        headers: {},
        body: '',
      },
      CRED_EJEMPLO,
      { region: 'us-east-1', service: 'service', fecha: new Date('2015-08-30T12:36:00Z') }
    );

    expect(headers['X-Amz-Date']).toBe('20150830T123600Z');
    expect(headers['Authorization']).toBe(
      'AWS4-HMAC-SHA256 ' +
      'Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
      'SignedHeaders=host;x-amz-date, ' +
      'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31'
    );
  });

  it('incluye X-Amz-Security-Token cuando la credencial es temporal (STS)', () => {
    // Las credenciales de Cognito son temporales y traen session token: va como
    // header Y firmado. Omitirlo hace que AWS rechace con firma inválida.
    const headers = firmarSigV4(
      {
        method: 'POST',
        url: 'https://x78kr8nqx5.execute-api.us-east-1.amazonaws.com/prod/algo',
        headers: { 'Content-Type': 'application/json' },
        body: '{"a":1}',
      },
      { accessKeyId: 'ASIA1', secretKey: 'sk', sessionToken: 'session-tok', expiration: 0 },
      { region: 'us-east-1', service: 'execute-api', fecha: new Date('2026-08-13T00:00:00Z') }
    );

    expect(headers['X-Amz-Security-Token']).toBe('session-tok');
    expect(headers['Authorization']).toContain('x-amz-security-token');
    expect(headers['Authorization']).toContain('Credential=ASIA1/20260813/us-east-1/execute-api/aws4_request');
  });
});
