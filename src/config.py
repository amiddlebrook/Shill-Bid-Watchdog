"""
Configuration management for ShillBidWatchdog
"""

import os
from typing import Optional


class Config:
    """
    Application configuration with environment variable support
    """
    
    # Database configuration
    DATABASE_URL: str = os.getenv(
        "DATABASE_URL", 
        "postgresql://localhost:5432/shillbid_watchdog"
    )
    
    # API configuration
    API_HOST: str = os.getenv("API_HOST", "0.0.0.0")
    API_PORT: int = int(os.getenv("API_PORT", "8000"))
    
    # Detection thresholds
    HIGH_BID_RATIO_THRESHOLD: float = float(
        os.getenv("HIGH_BID_RATIO_THRESHOLD", "0.4")
    )
    HIGH_CONCENTRATION_THRESHOLD: float = float(
        os.getenv("HIGH_CONCENTRATION_THRESHOLD", "0.7")
    )
    FREQUENT_PAIR_THRESHOLD: int = int(
        os.getenv("FREQUENT_PAIR_THRESHOLD", "3")
    )
    
    # Scraping configuration
    SCRAPE_DELAY_SECONDS: float = float(
        os.getenv("SCRAPE_DELAY_SECONDS", "1.0")
    )
    USER_AGENT: str = os.getenv(
        "USER_AGENT",
        "ShillBidWatchdog/0.1.0 (Educational Research Tool)"
    )
    
    # Alert configuration
    ALERT_WEBHOOK_URL: Optional[str] = os.getenv("ALERT_WEBHOOK_URL")
    
    @classmethod
    def get_database_url(cls) -> str:
        """Get database connection URL"""
        return cls.DATABASE_URL
    
    @classmethod
    def is_production(cls) -> bool:
        """Check if running in production mode"""
        return os.getenv("ENVIRONMENT", "development").lower() == "production"


# Singleton config instance
config = Config()
