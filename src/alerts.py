"""
Alert generator for shill bid detections
"""


class AlertGenerator:
    """
    Generates and displays evidence-backed alerts for shill bidding
    """
    
    def generate(self, detections):
        """
        Generate alerts from detections
        
        Args:
            detections (list): List of detection results
            
        Returns:
            list: List of formatted alerts
        """
        alerts = []
        for detection in detections:
            alert = {
                'auction_id': detection['auction_id'],
                'risk_level': detection['risk_level'],
                'violations': detection['violations'],
                'evidence': detection['evidence'],
                'summary': self._create_summary(detection)
            }
            alerts.append(alert)
        
        return alerts
    
    def _create_summary(self, detection):
        """
        Create a human-readable summary of the detection
        
        Args:
            detection (dict): Detection result
            
        Returns:
            str: Summary text
        """
        violation_count = len(detection['violations'])
        risk = detection['risk_level']
        
        summary = f"Detected {violation_count} suspicious pattern(s) - Risk Level: {risk}"
        return summary
    
    def display(self, alert):
        """
        Display an alert to the console
        
        Args:
            alert (dict): Alert to display
        """
        print()
        print(f"ALERT: Auction {alert['auction_id']}")
        print(f"Risk Level: {alert['risk_level']}")
        print(f"Summary: {alert['summary']}")
        print()
        print("Evidence:")
        
        for i, evidence in enumerate(alert['evidence'], 1):
            print(f"  {i}. {evidence['rule']}")
            print(f"     → {evidence['description']}")
            
            # Display details based on rule type
            details = evidence['details']
            if isinstance(details, list):
                for item in details:
                    if 'bidder_id' in item:
                        print(f"       • Bidder {item['bidder_id']}: {self._format_details(item)}")
                    elif 'bidders' in item:
                        print(f"       • Bidders {item['bidders']}: {item['count']} interactions")
            elif isinstance(details, dict):
                for key, value in details.items():
                    if key == 'concentration':
                        print(f"       • {value:.1%} bid concentration")
                    else:
                        print(f"       • {key}: {value}")
            print()
        
        print("-" * 60)
    
    def _format_details(self, item):
        """
        Format detail items for display
        
        Args:
            item (dict): Detail item
            
        Returns:
            str: Formatted string
        """
        parts = []
        for key, value in item.items():
            if key != 'bidder_id':
                if isinstance(value, float):
                    if 'ratio' in key:
                        parts.append(f"{key}={value:.1%}")
                    else:
                        parts.append(f"{key}={value:.2f}")
                else:
                    parts.append(f"{key}={value}")
        return ", ".join(parts)
