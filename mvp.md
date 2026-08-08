# Moneo — MVP

## Goal

Build a simple AI-powered personal finance app that helps users understand their money from transaction data.

## MVP Flow

1. User uploads a CSV from their bank.
2. Moneo parses and normalizes transactions.
3. Transactions are automatically categorized.
4. User gets a clean overview of:

   * Balance
   * Income
   * Spending
   * Categories
   * Recent transactions
5. User can ask AI questions about their finances.

## AI Examples

* "Where did most of my money go this month?"
* "How much did I spend on food?"
* "What subscriptions am I paying for?"
* "Is my spending higher than last month?"
* "How can I save €300 next month?"

## Views

Start with a few predefined financial views.

Later, users can create custom AI-generated views and share them through a marketplace. like claude has artifacts that make html interactive views making things easier to understand we will do the same 

## Not in MVP

* Bank account connections
* Investments
* Payments/transfers
* Complex budgeting
* View marketplace
* Native mobile app

## Tech

* React Native / Expo
* Web-first
* CSV import
* Database for transactions
* LLM for categorization, analysis, and chat

## Success

A user should be able to upload their bank CSV and understand their financial situation within a few minutes.
