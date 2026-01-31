"""
Data models for ShillBidWatchdog
Includes both SQLAlchemy ORM models and Pydantic schemas
"""

from datetime import datetime
from typing import List, Optional
from enum import Enum

from pydantic import BaseModel, Field
from sqlalchemy import Column, Integer, String, Float, DateTime, ForeignKey, Text, Boolean
from sqlalchemy.orm import relationship

from src.db import Base


# ============================================================================
# Enums
# ============================================================================

class RiskLevel(str, Enum):
    """Risk level enumeration"""
    NONE = "NONE"
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    CRITICAL = "CRITICAL"


# ============================================================================
# SQLAlchemy ORM Models (Database Tables)
# ============================================================================

class AuctionRecord(Base):
    """Database model for auction records"""
    __tablename__ = "auctions"
    
    id = Column(Integer, primary_key=True, index=True)
    auction_id = Column(String(100), unique=True, index=True, nullable=False)
    item_name = Column(String(500), nullable=False)
    current_price = Column(Float, nullable=True)
    start_price = Column(Float, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.utcnow())
    updated_at = Column(DateTime, default=lambda: datetime.utcnow(), onupdate=lambda: datetime.utcnow())
    
    # Relationships
    bids = relationship("BidRecord", back_populates="auction", cascade="all, delete-orphan")
    alerts = relationship("AlertRecord", back_populates="auction", cascade="all, delete-orphan")


class BidRecord(Base):
    """Database model for bid records"""
    __tablename__ = "bids"
    
    id = Column(Integer, primary_key=True, index=True)
    auction_id = Column(Integer, ForeignKey("auctions.id"), nullable=False)
    bidder_id = Column(String(100), index=True, nullable=False)
    amount = Column(Float, nullable=False)
    timestamp = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.utcnow())
    
    # Relationships
    auction = relationship("AuctionRecord", back_populates="bids")


class BidderRecord(Base):
    """Database model for bidder profiles"""
    __tablename__ = "bidders"
    
    id = Column(Integer, primary_key=True, index=True)
    bidder_id = Column(String(100), unique=True, index=True, nullable=False)
    total_bids = Column(Integer, default=0)
    total_wins = Column(Integer, default=0)
    total_auctions = Column(Integer, default=0)
    avg_bid_ratio = Column(Float, default=0.0)
    suspicion_score = Column(Float, default=0.0)
    first_seen = Column(DateTime, default=lambda: datetime.utcnow())
    last_seen = Column(DateTime, default=lambda: datetime.utcnow(), onupdate=lambda: datetime.utcnow())


class AlertRecord(Base):
    """Database model for alert records"""
    __tablename__ = "alerts"
    
    id = Column(Integer, primary_key=True, index=True)
    auction_id = Column(Integer, ForeignKey("auctions.id"), nullable=False)
    risk_level = Column(String(20), nullable=False)
    summary = Column(Text, nullable=True)
    violations = Column(Text, nullable=True)  # JSON string
    evidence = Column(Text, nullable=True)  # JSON string
    acknowledged = Column(Boolean, default=False)
    created_at = Column(DateTime, default=lambda: datetime.utcnow())
    
    # Relationships
    auction = relationship("AuctionRecord", back_populates="alerts")


# ============================================================================
# Pydantic Schemas (API/Validation)
# ============================================================================

class BidSchema(BaseModel):
    """Pydantic schema for a single bid"""
    bidder_id: str
    amount: float
    timestamp: Optional[datetime] = None
    
    class Config:
        from_attributes = True


class AuctionSchema(BaseModel):
    """Pydantic schema for auction data"""
    auction_id: str
    item_name: str
    current_price: float
    bids: List[BidSchema] = Field(default_factory=list)
    
    class Config:
        from_attributes = True


class BidderFeaturesSchema(BaseModel):
    """Pydantic schema for bidder behavioral features"""
    bidder_id: str
    bid_count: int
    bid_ratio: float
    avg_bid_amount: float
    never_won: bool


class AuctionFeaturesSchema(BaseModel):
    """Pydantic schema for auction-level features"""
    auction_id: str
    total_bids: int
    unique_bidders: int
    bid_concentration: float
    bidder_features: dict
    bidding_pairs: List[dict] = Field(default_factory=list)


class DetectionResultSchema(BaseModel):
    """Pydantic schema for detection results"""
    auction_id: str
    is_suspicious: bool
    risk_level: RiskLevel
    violations: List[str] = Field(default_factory=list)
    evidence: List[dict] = Field(default_factory=list)


class AlertSchema(BaseModel):
    """Pydantic schema for alerts"""
    auction_id: str
    risk_level: RiskLevel
    summary: str
    violations: List[str] = Field(default_factory=list)
    evidence: List[dict] = Field(default_factory=list)
    
    class Config:
        from_attributes = True
