# OpenSSH for tests/integration/database-ssh-ssl.test.ts. alice may forward anywhere; bob may
# forward only to a port nothing listens on, which is how "administratively prohibited" is met.
#
# sshd keeps the FIRST value it reads for a keyword, and Alpine's own sshd_config says
# `AllowTcpForwarding no` — so the settings go into sshd_config.d, which it includes at the top.
# A Match block runs to the end of the file it is in, so bob's goes at the end of the main file.
FROM alpine:3.20
RUN apk add --no-cache openssh-server \
 && adduser -D -s /bin/sh alice && echo 'alice:secret' | chpasswd \
 && adduser -D -s /bin/sh bob && echo 'bob:secret' | chpasswd \
 && ssh-keygen -A \
 && printf '%s\n' \
    'PasswordAuthentication yes' \
    'KbdInteractiveAuthentication no' \
    'AllowTcpForwarding yes' \
    'PermitRootLogin no' > /etc/ssh/sshd_config.d/ppm-test.conf \
 && printf '%s\n' \
    'Match User bob' \
    '  PermitOpen 127.0.0.1:1' >> /etc/ssh/sshd_config
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
