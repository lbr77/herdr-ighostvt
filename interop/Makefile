# Interop tools built from the iGhostVT sources, for test/*.test.js. macOS
# only (Network.framework, CryptoKit, corecrypto). IGHOSTVT is the iGhostVT
# checkout; the relay is built from its Relay/ with Go.
IGHOSTVT ?= ../../iGhostVT
SWIFTC = xcrun --sdk macosx swiftc -swift-version 5 -O
SHARED = $(IGHOSTVT)/Shared/Protocol/iGhostVTProtocol.swift \
	$(IGHOSTVT)/Shared/Protocol/iGhostVTXPC.swift \
	$(wildcard $(IGHOSTVT)/Shared/Wire/*.swift) \
	$(wildcard $(IGHOSTVT)/Shared/Remote/*.swift)

all: build/spake-oracle build/ghostvt-client build/ighostvt-relay

build/spake-oracle: spake-oracle/main.swift $(IGHOSTVT)/Shared/Remote/PairingExchange.swift
	@mkdir -p build
	$(SWIFTC) -I $(IGHOSTVT)/Shared/CoreCryptoShim $(IGHOSTVT)/Shared/Remote/PairingExchange.swift spake-oracle/main.swift -o $@

build/ghostvt-client: client/main.swift $(SHARED)
	@mkdir -p build
	$(SWIFTC) -I $(IGHOSTVT)/Shared/XPCShim -I $(IGHOSTVT)/Shared/CoreCryptoShim $(SHARED) client/main.swift -o $@

build/ighostvt-relay: $(wildcard $(IGHOSTVT)/Relay/**/*.go)
	@mkdir -p build
	cd $(IGHOSTVT)/Relay && go build -o $(CURDIR)/build/ighostvt-relay ./cmd/ighostvt-relay

clean:
	rm -rf build

.PHONY: all clean
