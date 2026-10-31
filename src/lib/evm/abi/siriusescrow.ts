// Généré par `pnpm contracts:abi` — ne pas modifier à la main.
// Source : contracts/src/SiriusEscrow.sol

export const siriusescrowAbi = [
  {
    "inputs": [
      {
        "internalType": "contract IERC20",
        "name": "usdc_",
        "type": "address"
      },
      {
        "internalType": "contract SiriusKybRegistry",
        "name": "kyb_",
        "type": "address"
      },
      {
        "internalType": "contract SiriusDatasetRegistry",
        "name": "datasets_",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "lockAuthorizer_",
        "type": "address"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "constructor"
  },
  {
    "inputs": [],
    "name": "AmountOverflow",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "AmountTooSmall",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint40",
        "name": "deadline",
        "type": "uint40"
      },
      {
        "internalType": "uint256",
        "name": "nowTs",
        "type": "uint256"
      }
    ],
    "name": "ChallengePeriodActive",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint40",
        "name": "deadline",
        "type": "uint40"
      },
      {
        "internalType": "uint256",
        "name": "nowTs",
        "type": "uint256"
      }
    ],
    "name": "ChallengePeriodElapsed",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "DatasetEscrowMismatch",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InexactTokenTransfer",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidChallengePeriod",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidDataset",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidHashlock",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidLoanId",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidLockAuthorization",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidPreimage",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidProvider",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidUsdcContract",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "KybRequired",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "loanKey",
        "type": "bytes32"
      }
    ],
    "name": "LoanExists",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "loanKey",
        "type": "bytes32"
      },
      {
        "internalType": "enum SiriusEscrow.Status",
        "name": "status",
        "type": "uint8"
      }
    ],
    "name": "LoanNotLocked",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "LockAuthorizationExpired",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NothingToWithdraw",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "Reentrancy",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "SelfDealing",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "Sha256Unavailable",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "TokenTransferFailed",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint8",
        "name": "tokenDecimals",
        "type": "uint8"
      }
    ],
    "name": "UnsupportedUsdcDecimals",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ZeroAddress",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ZeroAmount",
    "type": "error"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "account",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "loanKey",
        "type": "bytes32"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "balance",
        "type": "uint256"
      }
    ],
    "name": "CreditAccrued",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "loanKey",
        "type": "bytes32"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "borrower",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "provider",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint40",
        "name": "deadline",
        "type": "uint40"
      },
      {
        "indexed": false,
        "internalType": "bytes32",
        "name": "hashlock",
        "type": "bytes32"
      },
      {
        "indexed": false,
        "internalType": "bytes32",
        "name": "trainingProfile",
        "type": "bytes32"
      },
      {
        "indexed": false,
        "internalType": "uint64",
        "name": "seq",
        "type": "uint64"
      }
    ],
    "name": "LoanLocked",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "loanKey",
        "type": "bytes32"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "borrower",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint64",
        "name": "seq",
        "type": "uint64"
      }
    ],
    "name": "LoanRefunded",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "loanKey",
        "type": "bytes32"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "provider",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "caller",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "bytes32",
        "name": "preimage",
        "type": "bytes32"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "uint64",
        "name": "seq",
        "type": "uint64"
      }
    ],
    "name": "LoanReleased",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "hashlock",
        "type": "bytes32"
      },
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "loanKey",
        "type": "bytes32"
      },
      {
        "indexed": false,
        "internalType": "bytes32",
        "name": "preimage",
        "type": "bytes32"
      }
    ],
    "name": "PreimageRevealed",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "account",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      }
    ],
    "name": "Withdrawn",
    "type": "event"
  },
  {
    "inputs": [],
    "name": "LOAN_KEY_DOMAIN",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "MAX_CHALLENGE_DAYS",
    "outputs": [
      {
        "internalType": "uint8",
        "name": "",
        "type": "uint8"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "MIN_AMOUNT",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "MIN_CHALLENGE_DAYS",
    "outputs": [
      {
        "internalType": "uint8",
        "name": "",
        "type": "uint8"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "VERSION",
    "outputs": [
      {
        "internalType": "string",
        "name": "",
        "type": "string"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "accounting",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "locked",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "owed",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "balance",
        "type": "uint256"
      },
      {
        "internalType": "uint64",
        "name": "seq",
        "type": "uint64"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "datasetId",
        "type": "bytes32"
      }
    ],
    "name": "activeLoansForDataset",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "account",
        "type": "address"
      }
    ],
    "name": "creditOf",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "datasets",
    "outputs": [
      {
        "internalType": "contract SiriusDatasetRegistry",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "eventSeq",
    "outputs": [
      {
        "internalType": "uint64",
        "name": "",
        "type": "uint64"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "loanKey",
        "type": "bytes32"
      }
    ],
    "name": "getLoan",
    "outputs": [
      {
        "components": [
          {
            "internalType": "address",
            "name": "provider",
            "type": "address"
          },
          {
            "internalType": "uint96",
            "name": "amount",
            "type": "uint96"
          },
          {
            "internalType": "address",
            "name": "borrower",
            "type": "address"
          },
          {
            "internalType": "uint40",
            "name": "deadline",
            "type": "uint40"
          },
          {
            "internalType": "enum SiriusEscrow.Status",
            "name": "status",
            "type": "uint8"
          },
          {
            "internalType": "bytes32",
            "name": "hashlock",
            "type": "bytes32"
          },
          {
            "internalType": "bytes32",
            "name": "preimage",
            "type": "bytes32"
          },
          {
            "internalType": "bytes32",
            "name": "datasetId",
            "type": "bytes32"
          },
          {
            "internalType": "bytes32",
            "name": "trainingProfile",
            "type": "bytes32"
          }
        ],
        "internalType": "struct SiriusEscrow.Loan",
        "name": "",
        "type": "tuple"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "loanKey",
        "type": "bytes32"
      }
    ],
    "name": "isRefundable",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "loanKey",
        "type": "bytes32"
      }
    ],
    "name": "isReleasable",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "kyb",
    "outputs": [
      {
        "internalType": "contract SiriusKybRegistry",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "borrower",
        "type": "address"
      },
      {
        "internalType": "bytes32",
        "name": "loanIdHash",
        "type": "bytes32"
      }
    ],
    "name": "loanKeyOf",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "pure",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "provider",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      },
      {
        "internalType": "bytes32",
        "name": "hashlock",
        "type": "bytes32"
      },
      {
        "internalType": "uint8",
        "name": "challengeDays",
        "type": "uint8"
      },
      {
        "internalType": "bytes32",
        "name": "loanIdHash",
        "type": "bytes32"
      },
      {
        "internalType": "bytes32",
        "name": "datasetId",
        "type": "bytes32"
      },
      {
        "internalType": "bytes32",
        "name": "trainingProfile",
        "type": "bytes32"
      },
      {
        "components": [
          {
            "internalType": "uint40",
            "name": "deadline",
            "type": "uint40"
          },
          {
            "internalType": "bytes",
            "name": "signature",
            "type": "bytes"
          }
        ],
        "internalType": "struct SiriusEscrow.LockAuthorization",
        "name": "authorization",
        "type": "tuple"
      }
    ],
    "name": "lock",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "loanKey",
        "type": "bytes32"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "lockAuthorizer",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "lockedUsdc",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "loanKey",
        "type": "bytes32"
      },
      {
        "internalType": "address",
        "name": "borrower",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "provider",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      },
      {
        "internalType": "bytes32",
        "name": "hashlock",
        "type": "bytes32"
      },
      {
        "internalType": "bytes32",
        "name": "trainingProfile",
        "type": "bytes32"
      },
      {
        "internalType": "uint256",
        "name": "minimumRemaining",
        "type": "uint256"
      }
    ],
    "name": "matchesScope",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "owedUsdc",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "loanKey",
        "type": "bytes32"
      }
    ],
    "name": "preimageOf",
    "outputs": [
      {
        "internalType": "bool",
        "name": "revealed",
        "type": "bool"
      },
      {
        "internalType": "bytes32",
        "name": "preimage",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "loanKey",
        "type": "bytes32"
      }
    ],
    "name": "refund",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "loanKey",
        "type": "bytes32"
      },
      {
        "internalType": "bytes32",
        "name": "preimage",
        "type": "bytes32"
      }
    ],
    "name": "release",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "usdc",
    "outputs": [
      {
        "internalType": "contract IERC20",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "withdraw",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "account",
        "type": "address"
      }
    ],
    "name": "withdrawFor",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  }
] as const;
