// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "FileTransferFinderExtension",
    platforms: [
        .macOS(.v12)
    ],
    products: [
        .library(
            name: "FileTransferFinderExtension",
            type: .dynamic,
            targets: ["FileTransferFinderExtension"]
        )
    ],
    targets: [
        .target(
            name: "FileTransferFinderExtension",
            path: ".",
            sources: ["FinderSync.swift"],
            resources: [
                .process("Info.plist")
            ]
        )
    ]
)