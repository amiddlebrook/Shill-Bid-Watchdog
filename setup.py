from setuptools import setup, find_packages

setup(
    name="shill-bid-watchdog",
    version="0.1.0",
    description="External-only watchdog for detecting likely shill bidders in online auction houses",
    packages=find_packages(),
    install_requires=[
        "requests>=2.28.0",
        "beautifulsoup4>=4.11.0",
        "lxml>=4.9.0",
    ],
    python_requires=">=3.7",
    entry_points={
        "console_scripts": [
            "shill-watchdog=src.main:main",
        ],
    },
)
