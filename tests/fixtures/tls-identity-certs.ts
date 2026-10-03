/**
 * Certificates for tests/unit/services/database/tls-identity-check.test.ts: a test CA and two
 * servers it signed, one named `foo` and one named by the address 127.0.0.1. Valid for a century,
 * so nothing has to make them when the tests run. Made with:
 *
 *   openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 36500 \
 *     -subj "/CN=PPM tls-identity test CA" -addext basicConstraints=critical,CA:TRUE ...
 *   openssl x509 -req -CA ca.crt -CAkey ca.key -days 36500 -extfile <(echo subjectAltName=DNS:foo) ...
 *
 * The keys guard nothing: they exist only to be tested against.
 */
export const TEST_CA = `-----BEGIN CERTIFICATE-----
MIIBrTCCAVOgAwIBAgIUaIP4vOurNQdWE7RA3XYjFYJFYZMwCgYIKoZIzj0EAwIw
IzEhMB8GA1UEAwwYUFBNIHRscy1pZGVudGl0eSB0ZXN0IENBMCAXDTI2MDkzMDA5
MDIwMFoYDzIxMjYwOTA2MDkwMjAwWjAjMSEwHwYDVQQDDBhQUE0gdGxzLWlkZW50
aXR5IHRlc3QgQ0EwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAR4wWFpHHbjt2XJ
sGBN6j+bgBE5ZbmMVVo1L8YCZcLURiGLqIRSu+bwwf4/w/VfgwuAw+xZ+FMs/hOY
sCsmNfCOo2MwYTAdBgNVHQ4EFgQUpdBHnO/iqme4ZckVZJDiyD9pguYwHwYDVR0j
BBgwFoAUpdBHnO/iqme4ZckVZJDiyD9pguYwDwYDVR0TAQH/BAUwAwEB/zAOBgNV
HQ8BAf8EBAMCAQYwCgYIKoZIzj0EAwIDSAAwRQIhAOav6MmkflPjtmPVLhjgu3nd
t8YqcmHsU00PxYB1odjQAiA7dbpYFKCpwi6rxcOrwSL90MQadoZlto4zwYsblenp
mQ==
-----END CERTIFICATE-----
`;

/** subjectAltName DNS:foo */
export const FOO_CERT = `-----BEGIN CERTIFICATE-----
MIIBuTCCAV+gAwIBAgIUcDRf7y/a2KS08UwXaQeeruqRqRcwCgYIKoZIzj0EAwIw
IzEhMB8GA1UEAwwYUFBNIHRscy1pZGVudGl0eSB0ZXN0IENBMCAXDTI2MDkzMDA5
MDIwMFoYDzIxMjYwOTA2MDkwMjAwWjAOMQwwCgYDVQQDDANmb28wWTATBgcqhkjO
PQIBBggqhkjOPQMBBwNCAATg2E1pEc8ai/MVTlldvbDSqxG9jU1SZYNTvOB7ajMY
PwrylS/8RxvS0XTD1cautbQIv+rzhnTEYI1SAd/otbedo4GDMIGAMAkGA1UdEwQC
MAAwDgYDVR0PAQH/BAQDAgeAMBMGA1UdJQQMMAoGCCsGAQUFBwMBMA4GA1UdEQQH
MAWCA2ZvbzAdBgNVHQ4EFgQUE18k375DbJroFcb0kbQ9I5GEXtYwHwYDVR0jBBgw
FoAUpdBHnO/iqme4ZckVZJDiyD9pguYwCgYIKoZIzj0EAwIDSAAwRQIhAN3R1ZeV
fi/NgK8MCXlKGsyiPVyO/Tk8ThsnN1uuqNlgAiAtcXvOgliwnZOe1n7CexUtJN96
1W0W6eegzWTZlwUI9g==
-----END CERTIFICATE-----
`;
export const FOO_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg39eEY/9Mr0666Lpm
cck7ba0wquR9n4KGwuohUnLAjs6hRANCAATg2E1pEc8ai/MVTlldvbDSqxG9jU1S
ZYNTvOB7ajMYPwrylS/8RxvS0XTD1cautbQIv+rzhnTEYI1SAd/otbed
-----END PRIVATE KEY-----
`;

/** subjectAltName IP:127.0.0.1 */
export const IP_CERT = `-----BEGIN CERTIFICATE-----
MIIBuTCCAV+gAwIBAgIUcDRf7y/a2KS08UwXaQeeruqRqRgwCgYIKoZIzj0EAwIw
IzEhMB8GA1UEAwwYUFBNIHRscy1pZGVudGl0eSB0ZXN0IENBMCAXDTI2MDkzMDA5
MDIwMFoYDzIxMjYwOTA2MDkwMjAwWjANMQswCQYDVQQDDAJpcDBZMBMGByqGSM49
AgEGCCqGSM49AwEHA0IABGaayAkqYea03NLwIuBxfD9GEXNqoku5xpipE4/yiHnU
vrnqFVwTKDKCX+405UDARq+dmWPYoWpWJPwj2WcN41mjgYQwgYEwCQYDVR0TBAIw
ADAOBgNVHQ8BAf8EBAMCB4AwEwYDVR0lBAwwCgYIKwYBBQUHAwEwDwYDVR0RBAgw
BocEfwAAATAdBgNVHQ4EFgQUQIsrtIpLkAqnv0PcXSiVAKp9B1wwHwYDVR0jBBgw
FoAUpdBHnO/iqme4ZckVZJDiyD9pguYwCgYIKoZIzj0EAwIDSAAwRQIhAOocmfQ+
2AxSvfNM0cyA/9Jw0P09LBYWQM6OWXhKmF2hAiB/R80a98EABzR/e4z1eMNysd1W
KMZuuCRZLaELKOWK/A==
-----END CERTIFICATE-----
`;
export const IP_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg2aPHTzWfIWEvTSnE
RLIAxGtEbSRM3tTrRrceEdNDhguhRANCAARmmsgJKmHmtNzS8CLgcXw/RhFzaqJL
ucaYqROP8oh51L656hVcEygygl/uNOVAwEavnZlj2KFqViT8I9lnDeNZ
-----END PRIVATE KEY-----
`;
