import UIKit
import Vision
import VisionKit

/// Service for performing OCR on receipt images using Apple's Vision framework
class ReceiptOCRService {
    static let shared = ReceiptOCRService()
    
    private init() {}
    
    /// Extract text from a receipt image using Vision framework
    func extractText(from image: UIImage) async throws -> String {
        guard let cgImage = image.cgImage else {
            throw OCRError.invalidImage
        }
        
        return try await withCheckedThrowingContinuation { continuation in
            let request = VNRecognizeTextRequest { request, error in
                if let error = error {
                    continuation.resume(throwing: error)
                    return
                }
                
                guard let observations = request.results as? [VNRecognizedTextObservation] else {
                    continuation.resume(throwing: OCRError.noTextFound)
                    return
                }
                
                let recognizedText = observations.compactMap { observation in
                    observation.topCandidates(1).first?.string
                }.joined(separator: "\n")
                
                continuation.resume(returning: recognizedText)
            }
            
            // Configure for optimal receipt reading
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = true
            request.recognitionLanguages = ["en-US"]
            
            let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
            
            do {
                try handler.perform([request])
            } catch {
                continuation.resume(throwing: error)
            }
        }
    }
    
    /// Extract structured receipt data
    func extractReceiptData(from image: UIImage) async throws -> ReceiptData {
        let text = try await extractText(from: image)
        return parseReceiptText(text)
    }
    
    /// Parse raw OCR text into structured receipt data
    private func parseReceiptText(_ text: String) -> ReceiptData {
        var data = ReceiptData()
        data.rawText = text
        
        let lines = text.components(separatedBy: .newlines)
        
        // Extract store name (usually first non-empty line)
        if let firstLine = lines.first(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty }) {
            data.storeName = firstLine
        }
        
        // Extract date
        data.date = extractDate(from: text)
        
        // Extract total
        data.total = extractTotal(from: text)
        
        // Extract items
        data.items = extractLineItems(from: lines)
        
        return data
    }
    
    private func extractDate(from text: String) -> Date? {
        let datePatterns = [
            "\\d{1,2}/\\d{1,2}/\\d{2,4}",
            "\\d{1,2}-\\d{1,2}-\\d{2,4}",
            "\\d{4}-\\d{2}-\\d{2}"
        ]
        
        for pattern in datePatterns {
            if let range = text.range(of: pattern, options: .regularExpression) {
                let dateString = String(text[range])
                let formatter = DateFormatter()
                formatter.dateFormat = "MM/dd/yyyy"
                if let date = formatter.date(from: dateString) {
                    return date
                }
            }
        }
        
        return nil
    }
    
    private func extractTotal(from text: String) -> Decimal? {
        // Look for common total indicators
        let totalPatterns = [
            "total[:\\s]*\\$?([\\d,]+\\.\\d{2})",
            "amount[:\\s]*\\$?([\\d,]+\\.\\d{2})",
            "balance[:\\s]*\\$?([\\d,]+\\.\\d{2})"
        ]
        
        for pattern in totalPatterns {
            if let range = text.range(of: pattern, options: [.regularExpression, .caseInsensitive]) {
                let match = String(text[range])
                // Extract just the number
                if let numberRange = match.range(of: "[\\d,]+\\.\\d{2}", options: .regularExpression) {
                    let numberString = String(match[numberRange]).replacingOccurrences(of: ",", with: "")
                    return Decimal(string: numberString)
                }
            }
        }
        
        return nil
    }
    
    private func extractLineItems(from lines: [String]) -> [ReceiptLineItem] {
        var items: [ReceiptLineItem] = []
        
        for line in lines {
            // Look for lines with both a description and a price
            let pricePattern = "\\$?([\\d,]+\\.\\d{2})"
            if let priceRange = line.range(of: pricePattern, options: .regularExpression) {
                let price = String(line[priceRange])
                let description = line.replacingOccurrences(of: price, with: "").trimmingCharacters(in: .whitespaces)
                
                if !description.isEmpty && description.count > 2 {
                    let cleanPrice = price.replacingOccurrences(of: "$", with: "").replacingOccurrences(of: ",", with: "")
                    if let amount = Decimal(string: cleanPrice) {
                        items.append(ReceiptLineItem(description: description, amount: amount))
                    }
                }
            }
        }
        
        return items
    }
    
    enum OCRError: LocalizedError {
        case invalidImage
        case noTextFound
        
        var errorDescription: String? {
            switch self {
            case .invalidImage:
                return "Invalid image format"
            case .noTextFound:
                return "No text found in image"
            }
        }
    }
}

/// Structured receipt data model
struct ReceiptData {
    var rawText: String = ""
    var storeName: String?
    var date: Date?
    var total: Decimal?
    var items: [ReceiptLineItem] = []
    var tax: Decimal?
    var subtotal: Decimal?
    
    var formattedTotal: String {
        if let total = total {
            return NumberFormatter.currency.string(from: total as NSDecimalNumber) ?? "$0.00"
        }
        return "$0.00"
    }
    
    var formattedDate: String {
        if let date = date {
            return DateFormatter.mediumDate.string(from: date)
        }
        return "Unknown date"
    }
}

struct ReceiptLineItem: Identifiable {
    let id = UUID()
    var description: String
    var amount: Decimal
    var quantity: Int = 1
    
    var formattedAmount: String {
        NumberFormatter.currency.string(from: amount as NSDecimalNumber) ?? "$0.00"
    }
}

// MARK: - Formatters

extension NumberFormatter {
    static let currency: NumberFormatter = {
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        return formatter
    }()
}

extension DateFormatter {
    static let mediumDate: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        return formatter
    }()
}
