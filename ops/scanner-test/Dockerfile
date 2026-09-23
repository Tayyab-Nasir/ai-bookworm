# Test-only engine: official databases plus one harmless, exact-byte fixture.
FROM clamav/clamav:stable
ENV TZ=UTC
COPY bookworm.hsb /var/lib/clamav/bookworm.hsb
COPY clamd.conf /etc/clamav/bookworm.conf
USER clamav
ENTRYPOINT ["clamd", "--foreground=true", "--config-file=/etc/clamav/bookworm.conf"]
